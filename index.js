// index.js — демо-бот "приглашение на встречу" с Битрикс24 в роли источника истины
// для расписания и CRM. Локальная MongoDB используется для того, чтобы напоминания
// переживали перезапуск сервера, и чтобы у одного chatId была ровно одна "живая"
// сделка (без дублей при переносе времени).
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
  removeCalendarEvent,
  createBookingDeal,
  updateBookingDeal,
  getDeal,
  updateDealStage,
  BITRIX_TG_FIELD_NAME,
  ORG_TIMEZONE,
} from './bitrix.js';
import {
  zonedTimeToUTC,
  hhmmInTZ,
  nowInTZ,
  currentWeekRange,
  overlaps,
  pad2,
} from './bitrixTime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'webapp')));

const BOT_TOKEN = process.env.BOT_TOKEN;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_WEBHOOK_PATH = `/webhook/telegram/${BOT_TOKEN}`;
const BITRIX_WEBHOOK_PATH = '/webhook/bitrix';
const BITRIX_INCOMING_TOKEN = process.env.BITRIX_INCOMING_TOKEN || null; // задайте, если хотите проверять источник

const WORK_START_HOUR = Number(process.env.WORK_START_HOUR || 9);
const WORK_END_HOUR = Number(process.env.WORK_END_HOUR || 20); // последний слот начинается в WORK_END_HOUR - 1
const SLOT_MINUTES = 60;

// Стадии сделки в Битриксе — ОБЯЗАТЕЛЬНО подставьте реальные ID стадий вашей воронки.
const STAGE_NEW = process.env.BITRIX_NEW_STAGE_ID || 'NEW';
const STAGE_CONFIRMED = process.env.BITRIX_CONFIRMED_STAGE_ID || 'PREPARATION';
const STAGE_CANCELLED = process.env.BITRIX_CANCELLED_STAGE_ID || 'LOSE';
const STAGE_VISIT_CONFIRMED = process.env.BITRIX_VISIT_CONFIRMED_STAGE_ID || STAGE_CONFIRMED;
const WEBAPP_URL = process.env.WEBAPP_URL;

let db;
const mongoClient = process.env.MONGODB_URI ? new MongoClient(process.env.MONGODB_URI) : null;

async function connectDB() {
  if (!mongoClient) {
    console.warn('⚠️  MONGODB_URI не задан — напоминания не переживут перезапуск сервера, и не будет защиты от дублей сделок');
    return;
  }
  await mongoClient.connect();
  db = mongoClient.db('bitrix_demo');
  await db.collection('confirmedBookings').createIndex({ dealId: 1 }, { unique: true });
  // Ровно одна "живая" сделка на chatId — на ней и держится защита от дублей при переносе времени.
  await db.collection('activeBookingByChat').createIndex({ chatId: 1 }, { unique: true });
  console.log('✅ MongoDB подключена');
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

function humanTime(date) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: ORG_TIMEZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

// GET /api/slots — свободные часовые слоты на текущую неделю
app.get('/api/slots', async (req, res) => {
  const user = verifyInitData(req.query.initData);
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  try {
    const { monday, sunday } = currentWeekRange(ORG_TIMEZONE);
    const busy = await getBusyRanges(monday, sunday);

    const days = [];
    for (let i = 0; i < 7; i++) {
      const anchorDate = new Date(monday);
      anchorDate.setUTCDate(monday.getUTCDate() + i);
      const dateStr = `${anchorDate.getUTCFullYear()}-${pad2(anchorDate.getUTCMonth() + 1)}-${pad2(anchorDate.getUTCDate())}`;

      const slots = [];
      for (let h = WORK_START_HOUR; h < WORK_END_HOUR; h++) {
        const slotFrom = zonedTimeToUTC(dateStr, `${pad2(h)}:00`, ORG_TIMEZONE);
        const slotTo = new Date(slotFrom.getTime() + SLOT_MINUTES * 60 * 1000);

        // прошедшие слоты не показываем
        if (slotFrom < new Date()) continue;

        const isBusy = busy.some(b => overlaps(slotFrom, slotTo, b.from, b.to));
        if (!isBusy) slots.push(`${pad2(h)}:00`);
      }

      const weekday = new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', weekday: 'short' }).format(anchorDate);
      days.push({ dateStr, weekday, slots });
    }

    res.json({ days });
  } catch (err) {
    console.error('Ошибка получения слотов из Битрикса:', err.message);
    res.status(502).json({ error: 'bitrix_unavailable' });
  }
});

// POST /api/book — создать (или перенести) заявку на встречу: сделка в Битриксе +
// блокировка слота в календаре. Если у этого chatId уже есть "живая" сделка
// (например, после переноса времени), она ОБНОВЛЯЕТСЯ, а не создаётся заново —
// иначе в CRM плодятся неотличимые друг от друга копии.
app.post('/api/book', async (req, res) => {
  const user = verifyInitData(req.body.initData);
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  const { dateStr, time, topic, name, phone } = req.body;
  if (!dateStr || !time || !topic || !name || !phone) {
    return res.status(400).json({ error: 'invalid_input' });
  }

  try {
    // повторно проверяем занятость прямо перед записью — от гонки полностью не спасает,
    // но покрывает подавляющее большинство случаев для демо
    const fromDate = zonedTimeToUTC(dateStr, time, ORG_TIMEZONE);
    const toDate = new Date(fromDate.getTime() + SLOT_MINUTES * 60 * 1000);

    const busy = await getBusyRanges(fromDate, toDate);
    if (busy.some(b => overlaps(fromDate, toDate, b.from, b.to))) {
      return res.status(409).json({ error: 'slot_taken' });
    }

    const dealInput = {
      name, phone, topic, fromDate, toDate,
      chatId: user.id, username: user.username,
    };

    const existing = db
      ? await db.collection('activeBookingByChat').findOne({ chatId: user.id })
      : null;

    let dealId;
    if (existing) {
      dealId = existing.dealId;
      await updateBookingDeal(dealId, dealInput, STAGE_NEW);
      await removeCalendarEvent(existing.calendarEventId);
      // старая запись о подтверждении/напоминаниях больше не актуальна — обнуляем,
      // чтобы вебхук подтверждения и напоминания сработали заново для нового времени
      if (db) {
        await db.collection('confirmedBookings').updateOne(
          { dealId: String(dealId) },
          { $set: { status: 'rescheduled', confirmationSent: false, sentMorning: false, sentHour: false } },
        );
      }
    } else {
      dealId = await createBookingDeal(dealInput);
    }

    const calendarEventId = await blockCalendarSlot({
      fromDate, toDate,
      title: `${topic} — ${name} (заявка #${dealId})`,
    });

    if (db) {
      await db.collection('activeBookingByChat').updateOne(
        { chatId: user.id },
        { $set: { chatId: user.id, dealId, calendarEventId } },
        { upsert: true },
      );
    }

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

    const beginDate = deal.BEGINDATE; // ISO datetime со смещением зоны организации
    const dateTimeKey = String(beginDate);

    // Защита от дублей: если Битрикс дёрнет этот вебхук два раза на одном переходе
    // стадии (обычное дело для автоматизаций/роботов), сообщение клиенту уйдёт только раз.
    let alreadySent = false;
    if (db) {
      const existing = await db.collection('confirmedBookings').findOne({ dealId: String(dealId) });
      alreadySent = Boolean(existing && existing.confirmationSent && existing.dateTime === dateTimeKey);

      await db.collection('confirmedBookings').updateOne(
        { dealId: String(dealId) },
        {
          $set: { dealId: String(dealId), chatId, title: deal.TITLE, dateTime: dateTimeKey, status: 'confirmed' },
          $setOnInsert: { sentMorning: false, sentHour: false },
        },
        { upsert: true },
      );
      if (!alreadySent) {
        await db.collection('confirmedBookings').updateOne({ dealId: String(dealId) }, { $set: { confirmationSent: true } });
      }
    }

    if (!alreadySent) {
      const dt = new Date(beginDate);
      await sendMessage(chatId, `✅ Ваша запись на встречу подтверждена на ${humanTime(dt)}!`);
    }

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
  const timeStr = hhmmInTZ(dt, ORG_TIMEZONE);

  const text = kind === 'morning'
    ? `Доброе утро! Напоминаем, что у вас сегодня встреча в ${timeStr}. Вы будете?`
    : `Ждём вас через час (в ${timeStr})! Всё в силе?`;

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
    const { time, dateStr } = nowInTZ(ORG_TIMEZONE);
    const bookings = await db.collection('confirmedBookings').find({ status: 'confirmed' }).toArray();

    for (const booking of bookings) {
      const dt = new Date(booking.dateTime);
      const bookingDateStr = dt.toLocaleDateString('en-CA', { timeZone: ORG_TIMEZONE }); // YYYY-MM-DD
      if (bookingDateStr !== dateStr) continue;

      const classTimeStr = hhmmInTZ(dt, ORG_TIMEZONE);
      const hourBeforeStr = hhmmInTZ(subtractOneHour(dt), ORG_TIMEZONE);

      // Сравниваем строки "HH:MM" лексикографически — это работает, потому что
      // они всегда с ведущим нулём. Используем ">=", а не "===": если сервер на
      // бесплатном тарифе Render "проснулся" через несколько минут после нужного
      // времени (spin-down), напоминание всё равно уйдёт, а не потеряется молча.

      // Напоминание №1: с 08:00 и позже в день встречи (если ещё не отправляли)
      if (!booking.sentMorning && time >= '08:00') {
        await sendReminder(booking, 'morning');
        await db.collection('confirmedBookings').updateOne({ dealId: booking.dealId }, { $set: { sentMorning: true } });
      }

      // Напоминание №2: от "за час до начала" и до самого начала встречи
      if (!booking.sentHour && time >= hourBeforeStr && time < classTimeStr) {
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
    try {
      await updateDealStage(dealId, STAGE_VISIT_CONFIRMED);
    } catch (err) {
      console.error('Не удалось перевести сделку на стадию подтверждения визита:', err.message);
    }
    await sendMessage(chatId, '✅ Ждём вас, до встречи!');
    return;
  }

  // "Нет" — переводим сделку на стадию "нужен перенос", сразу предлагаем выбрать новое
  // время и глушим второе напоминание (нет смысла спрашивать второй раз в тот же день).
  // Сама сделка остаётся той же — новую копию создаст (и вернёт на STAGE_NEW) только
  // /api/book при повторной записи, см. комментарий там.
  try {
    await updateDealStage(dealId, STAGE_CANCELLED);
  } catch (err) {
    console.error('Не удалось обновить стадию сделки:', err.message);
  }
  if (db) {
    await db.collection('confirmedBookings').updateOne({ dealId }, { $set: { status: 'declined' } });
  }

  // Важно: тип кнопки именно web_app, а не url — обычная url-кнопка открывает страницу
  // в браузере БЕЗ initData от Telegram, и /api/slots не сможет авторизовать пользователя
  const keyboard = WEBAPP_URL
    ? { inline_keyboard: [[{ text: '📅 Выбрать другое время', web_app: { url: WEBAPP_URL } }]] }
    : undefined;
  await sendMessage(chatId, 'Жаль! Выберите, пожалуйста, новое время в приложении:', keyboard);
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
        '👋 Привет! Открой мини-приложение кнопкой снизу, чтобы посмотреть свободное время и записаться на встречу.'
      );
    }
  } catch (err) {
    console.error('Ошибка Telegram webhook:', err);
  }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Демо-сервер (Битрикс24) запущен на порту ${PORT}`));
