const express = require('express');
const cors = require('cors');
const multer = require('multer');
require('dotenv').config();

const { pool, initDb } = require('./db');
const { router: authRouter, requireAuth } = require('./auth');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

// Роуты /register, /login, /me
app.use(authRouter);

app.get('/', (req, res) => {
  res.json({ status: 'GeoLocate API running' });
});

// Сохраняет результат анализа; ошибка базы не должна ломать ответ пользователю
async function saveAnalysis(userId, imageName, result) {
  try {
    await pool.query(
      'INSERT INTO analyses (user_id, image_name, result) VALUES ($1, $2, $3)',
      [userId, imageName, JSON.stringify(result)]
    );
  } catch (e) {
    console.error('saveAnalysis error:', e);
  }
}

function extractExif(buffer) {
  try {
    const data = buffer;
    let offset = 0;
    if (data[0] !== 0xFF || data[1] !== 0xD8) return null;
    offset = 2;
    while (offset < data.length) {
      if (data[offset] !== 0xFF) break;
      const marker = data[offset + 1];
      const length = (data[offset + 2] << 8) | data[offset + 3];
      if (marker === 0xE1) {
        const exifHeader = data.slice(offset + 4, offset + 10).toString('ascii');
        if (exifHeader.startsWith('Exif')) {
          const tiffStart = offset + 10;
          const byteOrder = data.slice(tiffStart, tiffStart + 2).toString('ascii');
          const littleEndian = byteOrder === 'II';
          const readUInt16 = (o) => littleEndian ? data.readUInt16LE(tiffStart + o) : data.readUInt16BE(tiffStart + o);
          const readUInt32 = (o) => littleEndian ? data.readUInt32LE(tiffStart + o) : data.readUInt32BE(tiffStart + o);
          const ifdOffset = readUInt32(4);
          const entries = readUInt16(ifdOffset);
          let gpsIFDOffset = null;
          for (let i = 0; i < entries; i++) {
            const entryOffset = ifdOffset + 2 + i * 12;
            const tag = readUInt16(entryOffset);
            if (tag === 0x8825) {
              gpsIFDOffset = readUInt32(entryOffset + 8);
            }
          }
          if (gpsIFDOffset) {
            const gpsEntries = readUInt16(gpsIFDOffset);
            let latRef, lat, lngRef, lng;
            for (let i = 0; i < gpsEntries; i++) {
              const entryOffset = gpsIFDOffset + 2 + i * 12;
              const tag = readUInt16(entryOffset);
              const valueOffset = readUInt32(entryOffset + 8);
              if (tag === 1) latRef = String.fromCharCode(data[tiffStart + valueOffset]);
              if (tag === 3) lngRef = String.fromCharCode(data[tiffStart + valueOffset]);
              if (tag === 2 || tag === 4) {
                const d = data.readUInt32LE(tiffStart + valueOffset) / data.readUInt32LE(tiffStart + valueOffset + 4);
                const m = data.readUInt32LE(tiffStart + valueOffset + 8) / data.readUInt32LE(tiffStart + valueOffset + 12);
                const s = data.readUInt32LE(tiffStart + valueOffset + 16) / data.readUInt32LE(tiffStart + valueOffset + 20);
                const val = d + m / 60 + s / 3600;
                if (tag === 2) lat = val;
                if (tag === 4) lng = val;
              }
            }
            if (lat && lng) {
              return {
                lat: latRef === 'S' ? -lat : lat,
                lng: lngRef === 'W' ? -lng : lng
              };
            }
          }
        }
      }
      offset += 2 + length;
    }
  } catch (e) {}
  return null;
}

async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`, {
      headers: { 'User-Agent': 'GeoLocateApp/1.0' }
    });
    const data = await res.json();
    const city = data.address?.city || data.address?.town || data.address?.village || '';
    const country = data.address?.country || '';
    return `${city}, ${country}`.trim();
  } catch (e) {
    return null;
  }
}

// requireAuth: анализ доступен только вошедшим пользователям
app.post('/analyze', requireAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    const exif = extractExif(req.file.buffer);
    if (exif && exif.lat && exif.lng) {
      const location = await reverseGeocode(exif.lat, exif.lng);
      const gpsResult = {
        location: location || 'GPS location found',
        lat: parseFloat(exif.lat.toFixed(4)),
        lng: parseFloat(exif.lng.toFixed(4)),
        confidence: 99,
        source: 'GPS',
        clues: [
          'GPS coordinates extracted from photo metadata',
          `Latitude: ${exif.lat.toFixed(6)}`,
          `Longitude: ${exif.lng.toFixed(6)}`,
          'Location verified via OpenStreetMap'
        ]
      };
      await saveAnalysis(req.user.id, req.file.originalname, gpsResult);
      return res.json(gpsResult);
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const base64 = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype;

    const prompt = "You are an expert geolocator. Analyze this image carefully. PAY SPECIAL ATTENTION TO: 1. License plates - Belarus: white plate with red left stripe, BY flag. Ukraine: blue left stripe, UA flag. Russia: white with RUS. 2. Street signs and language of text. 3. Architecture. 4. Any flags or symbols. Be very precise - Belarus, Ukraine and Russia look similar but have different license plates. Respond ONLY with JSON, no markdown: {\"location\":\"City, Country\",\"lat\":0.0,\"lng\":0.0,\"confidence\":85,\"clues\":[\"clue1\",\"clue2\",\"clue3\",\"clue4\"]}";

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: prompt }
        ]
      }]
    });

    const text = response.content.map(c => c.text || '').join('');
    const result = JSON.parse(text.replace(/```json|```/g, '').trim());
    result.source = 'AI';
    await saveAnalysis(req.user.id, req.file.originalname, result);
    res.json(result);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;

// Сначала создаём таблицы, потом запускаем сервер
initDb()
  .then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
  .catch((err) => {
    console.error('DB init failed:', err);
    process.exit(1);
  });
