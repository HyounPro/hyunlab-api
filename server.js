const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── 데이터 저장 경로 (Render Disk: /data 마운트)
const DATA_DIR = process.env.DATA_DIR || '/data';
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const REVIEWS_DIR = path.join(DATA_DIR, 'reviews');

[DATA_DIR, PHOTOS_DIR, REVIEWS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── CORS: hyunlab.xyz 허용
app.use(cors({
  origin: [
    'https://hyunlab.xyz',
    'https://www.hyunlab.xyz',
    'http://localhost:3000',
    'http://127.0.0.1:5500'  // 로컬 개발용
  ],
  methods: ['GET', 'POST', 'DELETE']
}));

app.use(express.json({ limit: '1mb' }));

// ── 사진 정적 서빙
app.use('/photos', express.static(PHOTOS_DIR));

// ── multer: 메모리에 임시 저장 후 sharp로 압축
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB까지 받음
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('이미지 파일만 업로드 가능합니다'));
  }
});

// ────────────────────────────────────
//  사진 API
// ────────────────────────────────────

// 사진 목록 조회
app.get('/api/recipes/:id/photos', (req, res) => {
  const { id } = req.params;
  const indexFile = path.join(PHOTOS_DIR, `${id}.json`);
  if (!fs.existsSync(indexFile)) return res.json([]);
  const photos = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  res.json(photos);
});

// 사진 업로드 (이미지 압축 적용)
app.post('/api/recipes/:id/photos', upload.single('photo'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: '파일 없음' });

    const recipePhotoDir = path.join(PHOTOS_DIR, id);
    if (!fs.existsSync(recipePhotoDir)) fs.mkdirSync(recipePhotoDir, { recursive: true });

    const filename = `${Date.now()}.jpg`;
    const filepath = path.join(recipePhotoDir, filename);

    // sharp로 압축: 최대 1200px, JPEG quality 75
    await sharp(req.file.buffer)
      .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 75, progressive: true })
      .toFile(filepath);

    const stat = fs.statSync(filepath);
    const photoObj = {
      id: filename.replace('.jpg', ''),
      filename,
      url: `/photos/${id}/${filename}`,
      size: stat.size,
      uploadedAt: new Date().toISOString()
    };

    // 인덱스 파일 업데이트
    const indexFile = path.join(PHOTOS_DIR, `${id}.json`);
    const photos = fs.existsSync(indexFile)
      ? JSON.parse(fs.readFileSync(indexFile, 'utf8'))
      : [];
    photos.push(photoObj);
    fs.writeFileSync(indexFile, JSON.stringify(photos, null, 2));

    res.json(photoObj);
  } catch (err) {
    console.error('사진 업로드 오류:', err);
    res.status(500).json({ error: err.message });
  }
});

// 사진 삭제
app.delete('/api/recipes/:id/photos/:photoId', (req, res) => {
  try {
    const { id, photoId } = req.params;
    const indexFile = path.join(PHOTOS_DIR, `${id}.json`);
    if (!fs.existsSync(indexFile)) return res.status(404).json({ error: '없음' });

    let photos = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    const photo = photos.find(p => p.id === photoId);
    if (!photo) return res.status(404).json({ error: '사진 없음' });

    // 파일 삭제
    const filepath = path.join(PHOTOS_DIR, id, photo.filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);

    // 인덱스 업데이트
    photos = photos.filter(p => p.id !== photoId);
    fs.writeFileSync(indexFile, JSON.stringify(photos, null, 2));

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────
//  후기 API
// ────────────────────────────────────

// 후기 목록 조회
app.get('/api/recipes/:id/reviews', (req, res) => {
  const { id } = req.params;
  const reviewFile = path.join(REVIEWS_DIR, `${id}.json`);
  if (!fs.existsSync(reviewFile)) return res.json([]);
  res.json(JSON.parse(fs.readFileSync(reviewFile, 'utf8')));
});

// 후기 작성 (후기 사진도 함께)
app.post('/api/recipes/:id/reviews', upload.array('photos', 5), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, text, rating } = req.body;
    if (!text) return res.status(400).json({ error: '내용 없음' });

    // 후기 사진 처리
    const photoPaths = [];
    if (req.files && req.files.length > 0) {
      const reviewPhotoDir = path.join(PHOTOS_DIR, id, 'reviews');
      if (!fs.existsSync(reviewPhotoDir)) fs.mkdirSync(reviewPhotoDir, { recursive: true });

      for (const file of req.files) {
        const filename = `r_${Date.now()}_${Math.random().toString(36).slice(2,6)}.jpg`;
        const filepath = path.join(reviewPhotoDir, filename);
        await sharp(file.buffer)
          .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 70 })
          .toFile(filepath);
        photoPaths.push(`/photos/${id}/reviews/${filename}`);
      }
    }

    const review = {
      id: Date.now().toString(),
      name: name || '익명',
      text,
      rating: parseInt(rating) || 5,
      photos: photoPaths,
      date: new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\. /g, '.').replace('.', '')
    };

    const reviewFile = path.join(REVIEWS_DIR, `${id}.json`);
    const reviews = fs.existsSync(reviewFile)
      ? JSON.parse(fs.readFileSync(reviewFile, 'utf8'))
      : [];
    reviews.push(review);
    fs.writeFileSync(reviewFile, JSON.stringify(reviews, null, 2));

    res.json(review);
  } catch (err) {
    console.error('후기 저장 오류:', err);
    res.status(500).json({ error: err.message });
  }
});

// 후기 삭제
app.delete('/api/recipes/:id/reviews/:reviewId', (req, res) => {
  try {
    const { id, reviewId } = req.params;
    const reviewFile = path.join(REVIEWS_DIR, `${id}.json`);
    if (!fs.existsSync(reviewFile)) return res.status(404).json({ error: '없음' });

    let reviews = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
    const review = reviews.find(r => r.id === reviewId);
    if (review && review.photos) {
      review.photos.forEach(p => {
        const fp = path.join(DATA_DIR, p);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      });
    }
    reviews = reviews.filter(r => r.id !== reviewId);
    fs.writeFileSync(reviewFile, JSON.stringify(reviews, null, 2));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 헬스체크
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`hyunlab-api running on port ${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
});
