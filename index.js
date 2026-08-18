// index.js — демо-бот "запись на занятие" с Битрикс24 в роли источника истины
// для расписания и CRM. Локальная MongoDB используется ТОЛЬКО для того, чтобы
// напоминания переживали перезапуск сервера (сам список занятий/записей в Mongo не хранится).
//
// Обязательные переменные окружения — см. .env.example

import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import cron from 'node-cron';
import {
  getBusyRanges,
  blockCalendarSlot,
  createBookingDeal,
  getDeal,
  updateDealStage,
  BITRIX_TG_FIELD_NAME,
} from './bitrix.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'webapp')));

const BOT_TOKEN = process.env.BOT_TOKEN;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_WEBHOOK_PATH = `/webhook/telegram/${BOT_TOKEN}`;
const BITRIX_WEBHOOK_PATH = '/webhook/bitrix';
const BITRIX_INCOMING_TOKEN = process.env.BITRIX_INCOMING_TOKEN || null; // задайте, если хотите проверять источник

const STUDIO_TIMEZONE = process.env.STUDIO_TIMEZONE || 'Europe/Minsk';
const WORK_START_HOUR = Number(process.env.WORK_START_HOUR || 9);
const WORK_END_HOUR = Number(process.env.WORK_END_HOUR || 20); // последний слот начинается в WORK_END_HOUR - 1
const SLOT_MINUTES = 60;

// Стадии сделки в Битриксе — ОБЯЗАТЕЛЬНО подставьте реальные ID стадий вашей воронки
const STAGE_CONFIRMED = process.env.BITRIX_CONFIRMED_STAGE_ID || 'PREPARATION';
const STAGE_CANCELLED = process.env.BITRIX_CANCELLED_STAGE_ID || 'LOSE';

const DIRECTIONS = (process.env.DIRECTIONS || 'Pole Dance,Stretching,Exotic').split(',').map(s => s.trim());

let db;
const mongoClient = process.env.MONGODB_URI ? new MongoClient(process.env.MONGODB_URI) : null;

async function connectDB() {
  if (!mongoClient) {
    console.warn('⚠️  MONGODB_URI не задан — напоминания не переживут перезапуск сервера');
    return;
  }
  await mongoClient.connect();
  db = mongoClient.db('bitrix_demo');
  await db.collection('confirmedBookings').createIndex({ dealId: 1 }, { unique: true });
  console.log('✅ MongoDB подключена (только для состояния напоминаний)');
}
connectDB().catch(err => console.error('❌ Ошибка MongoDB:', err));

// ===================== Telegram helpers =====================

function sendMessage(chatId, text, keyboard) {
  const data = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) data.reply_markup = keyboard;
  return axios.post(`${API}/sendMessage`, data);
}

function answerCallback(callbackQueryId, text = '') {
  return axios.post(`${API}/answerCallbackQuery`, { callback_query_id: callbackQueryId, text });
}

function clearInlineKeyboard(chatId, messageId) {
  return axios.post(`${API}/editMessageReplyMarkup`, {
    chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] },
  }).catch(() => {});
}

function verifyInitData(initData) {
  try {
    const params = new URLSearchParams(initData || '');
    const hash = params.get('hash');
    params.delete('hash');
    const dataCheckArr = [];
    for (const [key, value] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      dataCheckArr.push(`${key}=${value}`);
    }
    const dataCheckString = dataCheckArr.join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computedHash !== hash) return null;
    const userJson = params.get('user');
    return userJson ? JSON.parse(userJson) : null;
  } catch {
    return null;
  }
}

// ===================== Время/слоты =====================

function pad2(n) { return String(n).padStart(2, '0'); }

function nowInStudioTZ() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: STUDIO_TIMEZONE, hour: '2-digit', minute: '2-digit',
    year: 'numeric', month: '2-digit', day: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return { time: `${map.hour}:${map.minute}`, dateStr: `${map.year}-${map.month}-${map.day}` };
}

// Локальная полночь понедельника текущей недели в таймзоне студии, как обычный Date
function currentWeekRange() {
  const today = new Date();
  const dow = today.getDay() === 0 ? 7 : today.getDay(); // пн=1..вс=7
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dow - 1));
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { monday, sunday };
}

function overlaps(aFrom, aTo, bFrom, bTo) {
  return aFrom < bTo && bFrom < aTo;
}

// GET /api/slots — свободные часовые слоты на текущую неделю
app.get('/api/slots', async (req, res) => {
  const user = verifyInitData(req.query.initData);
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  try {
    const { monday, sunday } = currentWeekRange();
    const busy = await getBusyRanges(monday, sunday);

    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(monday);
      date.setDate(monday.getDate() + i);
      const dateStr = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

      const slots = [];
      for (let h = WORK_START_HOUR; h < WORK_END_HOUR; h++) {
        const slotFrom = new Date(date);
        slotFrom.setHours(h, 0, 0, 0);
        const slotTo = new Date(slotFrom);
        slotTo.setMinutes(slotTo.getMinutes() + SLOT_MINUTES);

        // прошедшие слоты не показываем
        if (slotFrom < new Date()) continue;

        const isBusy = busy.some(b => overlaps(slotFrom, slotTo, b.from, b.to));
        if (!isBusy) slots.push(`${pad2(h)}:00`);
      }

      days.push({ dateStr, weekday: date.toLocaleDateString('ru-RU', { weekday: 'short' }), slots });
    }

    res.json({ days, directions: DIRECTIONS });
  } catch (err) {
    console.error('Ошибка получения слотов из Битрикса:', err.message);
    res.status(502).json({ error: 'bitrix_unavailable' });
  }
});

// POST /api/book — создать заявку: сделка в Битриксе + блокировка слота в календаре
app.post('/api/book', async (req, res) => {
  const user = verifyInitData(req.body.initData);
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  const { dateStr, time, direction, name, phone } = req.body;
  if (!dateStr || !time || !direction || !name || !phone) {
    return res.status(400).json({ error: 'invalid_input' });
  }

  try {
    // повторно проверяем занятость прямо перед записью — от гонки полностью не спасает,
    // но покрывает подавляющее большинство случаев для демо
    const [h, m] = time.split(':').map(Number);
    const fromDate = new Date(`${dateStr}T00:00:00`);
    fromDate.setHours(h, m, 0, 0);
    const toDate = new Date(fromDate);
    toDate.setMinutes(toDate.getMinutes() + SLOT_MINUTES);

    const busy = await getBusyRanges(fromDate, toDate);
    if (busy.some(b => overlaps(fromDate, toDate, b.from, b.to))) {
      return res.status(409).json({ error: 'slot_taken' });
    }

    const dealId = await createBookingDeal({
      name, phone, direction,
      fromISO: fromDate.toISOString(),
      toISO: toDate.toISOString(),
      chatId: user.id,
      username: user.username,
    });

    await blockCalendarSlot({
      fromISO: fromDate.toISOString(),
      toISO: toDate.toISOString(),
      title: `${direction} — ${name} (заявка #${dealId})`,
    });

    res.json({ ok: true, dealId });
  } catch (err) {
    console.error('Ошибка создания заявки:', err.message);
    res.status(502).json({ error: 'bitrix_unavailable' });
  }
});

// ===================== Вебхук от Битрикса: подтверждение записи =====================
//
// Настройка на стороне Битрикса: бизнес-процесс/робот на стадии "Время подтверждено",
// который делает POST на https://ваш-сервер/webhook/bitrix с телом { dealId, token }.
// token сверяется с BITRIX_INCOMING_TOKEN, если он задан.

app.post(BITRIX_WEBHOOK_PATH, async (req, res) => {
  const token = req.query.token ?? req.body.token;
  if (BITRIX_INCOMING_TOKEN && token !== BITRIX_INCOMING_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const dealId = req.query.id || req.body.dealId || req.body.id;
  if (!dealId) return res.status(400).json({ error: 'no_deal_id' });

  try {
    const deal = await getDeal(dealId);
    const chatId = Number(deal[BITRIX_TG_FIELD_NAME]);
    if (!chatId) return res.status(422).json({ error: 'no_telegram_id_on_deal' });

    const beginDate = deal.BEGINDATE; // ISO datetime
    if (db) {
      await db.collection('confirmedBookings').updateOne(
        { dealId: String(dealId) },
        { $set: {
          dealId: String(dealId), chatId, title: deal.TITLE,
          dateTime: beginDate, status: 'confirmed', sentMorning: false, sentHour: false,
        } },
        { upsert: true }
      );
    }

    const dt = new Date(beginDate);
    const humanTime = dt.toLocaleString('ru-RU', { timeZone: STUDIO_TIMEZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    await sendMessage(chatId, `✅ Ваша запись успешно подтверждена на ${humanTime}!`);

    res.json({ ok: true });
  } catch (err) {
    console.error('Ошибка обработки вебхука Битрикса:', err.message);
    res.status(502).json({ error: 'processing_failed' });
  }
});

// ===================== Два напоминания =====================

function subtractOneHour(date) {
  const d = new Date(date);
  d.setHours(d.getHours() - 1);
  return d;
}

async function sendReminder(booking, kind) {
  // kind: 'morning' | 'hour'
  const dt = new Date(booking.dateTime);
  const timeStr = dt.toLocaleTimeString('ru-RU', { timeZone: STUDIO_TIMEZONE, hour: '2-digit', minute: '2-digit' });

  const text = kind === 'morning'
    ? `Доброе утро! Напоминаем, что вы записаны сегодня на танцы в ${timeStr}. Вы будете?`
    : `Ждем вас через час (в ${timeStr})! Всё в силе?`;

  const yesLabel = kind === 'morning' ? '✅ Да, буду' : '✅ Да, еду';
  const noLabel = kind === 'morning' ? '❌ Нет, перенести' : '❌ Нет, не смогу';

  await sendMessage(booking.chatId, text, {
    inline_keyboard: [[
      { text: yesLabel, callback_data: `rem_${kind}_yes_${booking.dealId}` },
      { text: noLabel, callback_data: `rem_${kind}_no_${booking.dealId}` },
    ]],
  });
}

cron.schedule('* * * * *', async () => {
  if (!db) return;
  try {
    const { time, dateStr } = nowInStudioTZ();
    const bookings = await db.collection('confirmedBookings').find({ status: 'confirmed' }).toArray();

    for (const booking of bookings) {
      const dt = new Date(booking.dateTime);
      const bookingDateStr = dt.toLocaleDateString('en-CA', { timeZone: STUDIO_TIMEZONE }); // YYYY-MM-DD
      if (bookingDateStr !== dateStr) continue;

      // Напоминание №1: строго в 08:00 в день занятия
      if (!booking.sentMorning && time === '08:00') {
        await sendReminder(booking, 'morning');
        await db.collection('confirmedBookings').updateOne({ dealId: booking.dealId }, { $set: { sentMorning: true } });
      }

      // Напоминание №2: строго за 1 час до начала
      const hourBefore = subtractOneHour(dt);
      const hourBeforeStr = hourBefore.toLocaleTimeString('ru-RU', { timeZone: STUDIO_TIMEZONE, hour: '2-digit', minute: '2-digit' }).replace('.', ':');
      if (!booking.sentHour && hourBeforeStr === time) {
        await sendReminder(booking, 'hour');
        await db.collection('confirmedBookings').updateOne({ dealId: booking.dealId }, { $set: { sentHour: true } });
      }
    }
  } catch (err) {
    console.error('Ошибка планировщика напоминаний:', err);
  }
});

// ===================== Telegram webhook: /start + кнопки напоминаний =====================

async function handleReminderCallback(cq) {
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const data = cq.data || '';
  const match = /^rem_(morning|hour)_(yes|no)_(.+)$/.exec(data);
  if (!match) return answerCallback(cq.id);

  const [, kind, answer, dealId] = match;
  await answerCallback(cq.id, answer === 'yes' ? 'Отлично!' : 'Хорошо');
  await clearInlineKeyboard(chatId, messageId);

  if (answer === 'yes') {
    await sendMessage(chatId, '✅ Ждём вас, до встречи!');
    return;
  }

  // "Нет" — переводим сделку в стадию отмены/переноса и уведомляем клиента
  try {
    await updateDealStage(dealId, STAGE_CANCELLED);
  } catch (err) {
    console.error('Не удалось обновить стадию сделки:', err.message);
  }
  if (db) {
    await db.collection('confirmedBookings').updateOne({ dealId }, { $set: { status: 'cancelled' } });
  }
  await sendMessage(chatId, 'Хорошо, отметили это в CRM. Свяжемся с вами насчёт переноса 🙌');
}

app.post(TELEGRAM_WEBHOOK_PATH, async (req, res) => {
  const update = req.body;
  try {
    if (update.callback_query) {
      await handleReminderCallback(update.callback_query);
      return res.sendStatus(200);
    }
    if (update.message?.text === '/start') {
      await sendMessage(
        update.message.chat.id,
        '👋 Привет! Открой мини-приложение кнопкой снизу, чтобы посмотреть свободное время и записаться.'
      );
    }
  } catch (err) {
    console.error('Ошибка Telegram webhook:', err);
  }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Демо-сервер (Битрикс24) запущен на порту ${PORT}`));
