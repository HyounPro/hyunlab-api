const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BUCKET = 'recipe-photos';

// ── CORS
app.use(cors({
  origin: [
    'https://hyunlab.xyz',
    'https://www.hyunlab.xyz',
    'http://localhost:3000',
    'http://127.0.0.1:5500'
  ],
  methods: ['GET', 'POST', 'DELETE']
}));
app.use(express.json());

// ── multer 메모리 저장
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('이미지 파일만 가능합니다'));
  }
});

// ── Supabase fetch 헬퍼
async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
  return res;
}

// ════════════════════════════════
//  사진 API
// ════════════════════════════════

// 사진 목록
app.get('/api/recipes/:id/photos', async (req, res) => {
  try {
    const { id } = req.params;
    const r = await sbFetch(`/rest/v1/photos?recipe_id=eq.${id}&order=created_at.asc`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 사진 업로드
app.post('/api/recipes/:id/photos', upload.single('photo'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: '파일 없음' });

    // sharp 압축: 최대 1200px, JPEG quality 75
    const compressed = await sharp(req.file.buffer)
      .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 75, progressive: true })
      .toBuffer();

    const filename = `${id}/${Date.now()}.jpg`;

    // Supabase Storage 업로드
    const uploadRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${filename}`,
      {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'image/jpeg',
          'x-upsert': 'true'
        },
        body: compressed
      }
    );
    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      throw new Error('Storage 업로드 실패: ' + err);
    }

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${filename}`;
    const sizeKB = Math.round(compressed.length / 1024);

    // DB에 메타 저장
    const dbRes = await sbFetch('/rest/v1/photos', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ recipe_id: id, url: publicUrl, filename, size_kb: sizeKB })
    });
    const [photo] = await dbRes.json();
    res.json(photo);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// 사진 삭제
app.delete('/api/recipes/:id/photos/:photoId', async (req, res) => {
  try {
    const { id, photoId } = req.params;

    // DB에서 파일명 조회
    const r = await sbFetch(`/rest/v1/photos?id=eq.${photoId}`);
    const [photo] = await r.json();
    if (!photo) return res.status(404).json({ error: '없음' });

    // Storage 삭제
    await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${photo.filename}`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });

    // DB 삭제
    await sbFetch(`/rest/v1/photos?id=eq.${photoId}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════
//  후기 API
// ════════════════════════════════

// 후기 목록
app.get('/api/recipes/:id/reviews', async (req, res) => {
  try {
    const { id } = req.params;
    const r = await sbFetch(`/rest/v1/reviews?recipe_id=eq.${id}&order=created_at.asc`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 후기 작성
app.post('/api/recipes/:id/reviews', upload.array('photos', 5), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, text, rating } = req.body;
    if (!text) return res.status(400).json({ error: '내용 없음' });

    // 후기 사진 업로드
    const photoPaths = [];
    for (const file of (req.files || [])) {
      const compressed = await sharp(file.buffer)
        .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
      const filename = `${id}/reviews/${Date.now()}_${Math.random().toString(36).slice(2,5)}.jpg`;
      await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${filename}`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'image/jpeg',
          'x-upsert': 'true'
        },
        body: compressed
      });
      photoPaths.push(`${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${filename}`);
    }

    const now = new Date();
    const date = `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,'0')}.${String(now.getDate()).padStart(2,'0')}`;

    const dbRes = await sbFetch('/rest/v1/reviews', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({
        recipe_id: id,
        name: name || '익명',
        text,
        rating: parseInt(rating) || 5,
        photos: photoPaths,
        date
      })
    });
    const [review] = await dbRes.json();
    res.json(review);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// 후기 삭제
app.delete('/api/recipes/:id/reviews/:reviewId', async (req, res) => {
  try {
    const { reviewId } = req.params;
    await sbFetch(`/rest/v1/reviews?id=eq.${reviewId}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 헬스체크
app.get('/health', (req, res) => res.json({ status: 'ok', supabase: !!SUPABASE_URL }));

app.listen(PORT, () => console.log(`hyunlab-api running on port ${PORT}`));
