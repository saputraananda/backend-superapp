import express from 'express';
import { uploadAvatar, uploadDocument } from '../middleware/upload.js';

const router = express.Router();

function requireInternalKey(req, res, next) {
  if (req.headers['x-internal-key'] !== process.env.WASCHEN_INTERNAL_KEY)
    return res.status(401).json({ message: 'Unauthorized' });
  next();
}

router.post('/upload/:docType', requireInternalKey, (req, res, next) => {
  const multerInstance = req.params.docType === 'profile' ? uploadAvatar : uploadDocument;
  multerInstance.single('doc')(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message });
    if (!req.file) return res.status(400).json({ message: 'File tidak ditemukan' });
    res.json({ data: { file_name: req.file.filename } });
  });
});

export default router;
