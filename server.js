require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.set('trust proxy', 1);

const port = Number(process.env.PORT) || 3000;
const maxFileSize = 100 * 1024 * 1024;
const storageBucket = process.env.SUPABASE_STORAGE_BUCKET || 'event-media';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured.'
  );
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function getEventId(value) {
  const eventId = String(value || '').trim();

  if (!/^[a-z0-9-]{3,80}$/.test(eventId)) {
    throw new Error('A valid event code is required.');
  }

  return eventId;
}

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: maxFileSize },
  fileFilter: (_request, file, callback) => {
    const allowed = ['image/', 'video/'].some((type) => file.mimetype.startsWith(type));
    callback(allowed ? null : new Error('Only image and video files are supported.'), allowed);
  }
});

const submissionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'Too many submissions. Please wait a minute before trying again.'
  }
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'Too many administrative requests. Please try again later.'
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_request, response) => response.redirect('/upload'));
app.get('/upload', (_request, response) => response.sendFile(path.join(__dirname, 'public', 'upload.html')));
app.get('/display', (_request, response) => response.sendFile(path.join(__dirname, 'public', 'display.html')));

io.on('connection', (socket) => {
  socket.on('event:join', (payload) => {
    try {
      const eventId = getEventId(payload && payload.eventId);
      socket.join(eventId);
      socket.emit('event:joined', { eventId });
    } catch (error) {
      socket.emit('event:error', { error: error.message });
    }
  });
});

app.post('/api/submissions', submissionLimiter, upload.single('media'), async (request, response, next) => {
  try {
    const eventId = getEventId(request.body.eventId);
    const message = String(request.body.message || '').trim().slice(0, 280);
    const name = String(request.body.name || '').trim().slice(0, 60);

    if (!message && !request.file) {
      return response.status(400).json({
        error: 'Add a message, photo, or video before sending.'
      });
    }

    let mediaUrl = null;
    let mediaType = null;

    if (request.file) {
      const extension = path.extname(request.file.originalname).toLowerCase();
      const storagePath = `${Date.now()}-${crypto.randomUUID()}${extension}`;

      const { error: uploadError } = await supabase.storage
        .from(storageBucket)
        .upload(storagePath, request.file.buffer, {
          contentType: request.file.mimetype,
          upsert: false
        });

      if (uploadError) {
        throw new Error(`Unable to upload media: ${uploadError.message}`);
      }

      const { data: publicUrlData } = supabase.storage
        .from(storageBucket)
        .getPublicUrl(storagePath);

      mediaUrl = publicUrlData.publicUrl;
      mediaType = request.file.mimetype.split('/')[0];
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    const { data: row, error: databaseError } = await supabase
      .from('submissions')
      .insert({
        id,
        event_id: eventId,
        message,
        name,
        media_url: mediaUrl,
        media_type: mediaType,
        created_at: createdAt
      })
      .select('id, event_id, message, name, media_url, media_type, created_at')
      .single();

    if (databaseError) {
      throw new Error(`Unable to save submission: ${databaseError.message}`);
    }

    const submission = {
      id: row.id,
      eventId: row.event_id,
      message: row.message,
      name: row.name,
      mediaUrl: row.media_url,
      mediaType: row.media_type,
      createdAt: row.created_at
    };

    io.to(eventId).emit('submission:new', submission);
    return response.status(201).json({ submission });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/submissions', async (request, response, next) => {
  try {
    const eventId = getEventId(request.query.event);
    const { data: rows, error } = await supabase
      .from('submissions')
      .select('id, event_id, message, name, media_url, media_type, created_at')
      .eq('event_id', eventId)
      .order('created_at', { ascending: true })
      .limit(100);

    if (error) {
      throw new Error(`Unable to load submissions: ${error.message}`);
    }

    const submissions = rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      message: row.message,
      name: row.name,
      mediaUrl: row.media_url,
      mediaType: row.media_type,
      createdAt: row.created_at
    }));

    return response.json({ submissions });
  } catch (error) {
    return next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error(error);

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
