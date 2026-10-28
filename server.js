require('dotenv').config();

const express = require('express');
const http = require('http');
const fs = require('fs');
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

function getSubmissionId(value) {
  const id = String(value || '').trim();

  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error('A valid submission is required.');
  }

  return id;
}

const moderationPath = path.join(__dirname, 'data', 'moderation.json');
let moderation = { seeded: false, items: {} };

function loadModeration() {
  try {
    const saved = JSON.parse(fs.readFileSync(moderationPath, 'utf8'));
    moderation = {
      seeded: Boolean(saved.seeded),
      items: saved.items && typeof saved.items === 'object' ? saved.items : {}
    };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(error);
    moderation = { seeded: false, items: {} };
  }
}

function saveModeration() {
  fs.mkdirSync(path.dirname(moderationPath), { recursive: true });
  fs.writeFileSync(moderationPath, JSON.stringify(moderation));
}

function statusFor(id) {
  return moderation.items[id] === 'hidden' ? 'hidden' : 'approved';
}

function setStatus(id, status) {
  moderation.items[id] = status;
  saveModeration();
}

function storagePathFromPublicUrl(url) {
  if (!url) return null;
  const marker = `/object/public/${storageBucket}/`;
  const index = url.indexOf(marker);
  if (index === -1) return null;
  return decodeURIComponent(url.slice(index + marker.length).split('?')[0]);
}

function toSubmission(row, includeStatus) {
  const submission = {
    id: row.id,
    eventId: row.event_id,
    message: row.message,
    name: row.name,
    mediaUrl: row.media_url,
    mediaType: row.media_type,
    createdAt: row.created_at
  };

  if (includeStatus) submission.status = statusFor(row.id);
  return submission;
}

function moderatorKeyMatches(provided) {
  const expected = process.env.MODERATOR_PASSWORD || '';
  const left = Buffer.from(String(provided || ''));
  const right = Buffer.from(expected);

  if (!expected || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function requireModerator(request, response) {
  if (!process.env.MODERATOR_PASSWORD) {
    response.status(503).json({ error: 'Screening password is not configured.' });
    return false;
  }

  if (!moderatorKeyMatches(request.get('x-moderator-key'))) {
    response.status(401).json({ error: 'Enter the screening password to continue.' });
    return false;
  }

  return true;
}

async function seedExistingSubmissions() {
  loadModeration();

  let changed = false;
  for (const [id, status] of Object.entries(moderation.items)) {
    if (status === 'pending') {
      moderation.items[id] = 'approved';
      changed = true;
    }
  }
  if (changed) saveModeration();

  if (moderation.seeded) return;

  const { data, error } = await supabase.from('submissions').select('id');

  if (error) {
    console.error(`Unable to prepare screening: ${error.message}`);
    return;
  }

  for (const row of data || []) {
    if (!moderation.items[row.id]) moderation.items[row.id] = 'approved';
  }

  moderation.seeded = true;
  saveModeration();
}

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: maxFileSize },
  fileFilter: (_request, file, callback) => {
    const allowed = file.mimetype === 'image/jpeg' || file.mimetype === 'image/png';
    callback(allowed ? null : new Error('Only JPG and PNG photos are supported.'), allowed);
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
app.get('/screen', (_request, response) => response.sendFile(path.join(__dirname, 'public', 'screen.html')));

io.on('connection', (socket) => {
  socket.on('event:join', async (payload) => {
    try {
      const eventId = getEventId(payload && payload.eventId);
      socket.join(eventId);
      const { data: rows, error } = await supabase
        .from('submissions')
        .select('id, event_id, message, name, media_url, media_type, created_at')
        .eq('event_id', eventId)
        .order('created_at', { ascending: true })
        .limit(500);

      if (error) throw new Error(error.message);

      const submissions = (rows || [])
        .filter((row) => statusFor(row.id) === 'approved')
        .map((row) => toSubmission(row));

      socket.emit('event:joined', { eventId, submissions });
    } catch (error) {
      socket.emit('event:error', { error: error.message });
    }
  });
});

app.post('/api/submissions', submissionLimiter, upload.single('media'), async (request, response, next) => {
  try {
    const eventId = getEventId(request.body.eventId);
    const message = String(request.body.message || '').trim().slice(0, 120);
    const name = String(request.body.name || '').trim().slice(0, 60);

    if (!message && !request.file) {
      return response.status(400).json({
        error: 'Add a message or photo before sending.'
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

    setStatus(id, 'approved');

    const submission = toSubmission(row);
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
      .limit(500);

    if (error) {
      throw new Error(`Unable to load submissions: ${error.message}`);
    }

    const submissions = rows
      .filter((row) => statusFor(row.id) === 'approved')
      .map((row) => toSubmission(row));

    return response.json({ submissions });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/moderation/submissions', adminLimiter, async (request, response, next) => {
  try {
    if (!requireModerator(request, response)) return;

    const eventId = getEventId(request.query.event);
    const { data: rows, error } = await supabase
      .from('submissions')
      .select('id, event_id, message, name, media_url, media_type, created_at')
      .eq('event_id', eventId)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      throw new Error(`Unable to load submissions: ${error.message}`);
    }

    return response.json({
      submissions: rows.map((row) => toSubmission(row, true))
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/moderation/submissions/:id', adminLimiter, async (request, response, next) => {
  try {
    if (!requireModerator(request, response)) return;

    const id = getSubmissionId(request.params.id);
    const eventId = getEventId(request.body.eventId);
    const action = String(request.body.action || '');

    if (!['approve', 'hide', 'delete'].includes(action)) {
      return response.status(400).json({ error: 'Choose show, hide, or delete.' });
    }

    const { data: row, error } = await supabase
      .from('submissions')
      .select('id, event_id, message, name, media_url, media_type, created_at')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      throw new Error(`Unable to load submission: ${error.message}`);
    }

    if (!row || row.event_id !== eventId) {
      return response.status(404).json({ error: 'That submission is not in this event.' });
    }

    if (action === 'delete') {
      const storagePath = storagePathFromPublicUrl(row.media_url);

      if (storagePath) {
        const { error: storageError } = await supabase.storage.from(storageBucket).remove([storagePath]);
        if (storageError) console.error(storageError);
      }

      const { error: deleteError } = await supabase.from('submissions').delete().eq('id', id);

      if (deleteError) {
        throw new Error(`Unable to delete submission: ${deleteError.message}`);
      }

      delete moderation.items[id];
      saveModeration();
      io.to(eventId).emit('submission:removed', { id });
      return response.json({ ok: true });
    }

    const status = action === 'approve' ? 'approved' : 'hidden';
    setStatus(id, status);

    if (status === 'approved') {
      io.to(eventId).emit('submission:new', toSubmission(row));
    } else {
      io.to(eventId).emit('submission:removed', { id });
    }

    return response.json({ submission: toSubmission(row, true) });
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

seedExistingSubmissions().then(() => {
  server.listen(port, '0.0.0.0', () => {
    console.log(`Live event wall running at http://localhost:${port}`);
    console.log(`Participants: http://YOUR-LAPTOP-IP:${port}/upload`);
    console.log(`Display:      http://localhost:${port}/display`);
    console.log(`Screening:    http://localhost:${port}/screen`);
  });
});
