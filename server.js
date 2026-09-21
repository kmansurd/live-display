const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = Number(process.env.PORT) || 3000;
const uploadDirectory = path.join(__dirname, 'public', 'uploads');
const maxFileSize = 100 * 1024 * 1024;

fs.mkdirSync(uploadDirectory, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDirectory,
  filename: (_request, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, `${Date.now()}-${crypto.randomUUID()}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: maxFileSize },
  fileFilter: (_request, file, callback) => {
    const allowed = ['image/', 'video/'].some((type) => file.mimetype.startsWith(type));
    callback(allowed ? null : new Error('Only image and video files are supported.'), allowed);
  }
});

const submissions = [];
const maxSubmissions = 100;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_request, response) => response.redirect('/upload'));
app.get('/upload', (_request, response) => response.sendFile(path.join(__dirname, 'public', 'upload.html')));
app.get('/display', (_request, response) => response.sendFile(path.join(__dirname, 'public', 'display.html')));

app.post('/api/submissions', upload.single('media'), (request, response) => {
  const message = String(request.body.message || '').trim().slice(0, 280);
  const name = String(request.body.name || '').trim().slice(0, 60);

  if (!message && !request.file) {
    return response.status(400).json({ error: 'Add a message, photo, or video before sending.' });
  }

  const submission = {
    id: crypto.randomUUID(),
    message,
    name,
    mediaUrl: request.file ? `/uploads/${request.file.filename}` : null,
    mediaType: request.file ? request.file.mimetype.split('/')[0] : null,
    createdAt: new Date().toISOString()
  };

  submissions.push(submission);
  while (submissions.length > maxSubmissions) submissions.shift();

  io.emit('submission:new', submission);
  return response.status(201).json({ submission });
});

app.get('/api/submissions', (_request, response) => {
  response.json({ submissions });
});

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return response.status(413).json({ error: 'Files must be smaller than 100 MB.' });
  }
  return response.status(400).json({ error: error.message || 'Unable to process submission.' });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Live event wall running at http://localhost:${port}`);
  console.log(`Participants: http://YOUR-LAPTOP-IP:${port}/upload`);
  console.log(`Display:      http://localhost:${port}/display`);
});
