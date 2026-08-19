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
  overlaps,
  pad2,
  parseBitrixDateTime,
  dateStrToAnchor,
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
// Сколько дней вперёд показываем "лентой" по умолчанию (не привязано к пн-вс,
// а всегда начинается с сегодня — см. /api/slots).
const ROLLING_DAYS_AHEAD = Number(process.env.ROLLING_DAYS_AHEAD || 7);
// Насколько далеко в будущее можно заглянуть через календарь/дата-пикер в приложении.
const MAX_DAYS_AHEAD = Number(process.env.MAX_DAYS_AHEAD || 60);

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

function slotsForDay(anchorDate, dateStr, busy) {
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
  return { dateStr, weekday, slots };
}

// GET /api/slots — свободные часовые слоты.
//
// ФИКС "дни пропадают/остаются пустыми не той длины": раньше лента всегда строилась
// от понедельника до воскресенья ТЕКУЩЕЙ недели — если сегодня, скажем, среда, то
// понедельник и вторник всё равно попадали в список, просто с пустыми слотами
// ("нет свободных окон"), а в следующий понедельник список резко "перепрыгивал"
// на новую неделю. Теперь лента всегда начинается с СЕГОДНЯ и просто едет вперёд
// на ROLLING_DAYS_AHEAD дней — прошедшие дни никогда не показываются вообще.
//
// Опционально: ?date=YYYY-MM-DD — вернуть слоты только на одну конкретную дату
// (используется календарём/дата-пикером в приложении для дат вне ближайшей ленты).
app.get('/api/slots', async (req, res) => {
  const user = verifyInitData(req.query.initData);
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  const { dateStr: todayStr } = nowInTZ(ORG_TIMEZONE);
  const todayAnchor = dateStrToAnchor(todayStr);

  try {
    if (req.query.date) {
      const requestedStr = String(req.query.date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedStr)) {
        return res.status(400).json({ error: 'invalid_date' });
      }
      const anchor = dateStrToAnchor(requestedStr);
      const daysDiff = Math.round((anchor.getTime() - todayAnchor.getTime()) / 86400000);
      if (daysDiff < 0 || daysDiff > MAX_DAYS_AHEAD) {
        return res.status(400).json({ error: 'date_out_of_range' });
      }
      const dayStart = new Date(anchor);
      const dayEnd = new Date(anchor.getTime() + 24 * 60 * 60 * 1000);
      const busy = await getBusyRanges(dayStart, dayEnd);
      return res.json({ days: [slotsForDay(anchor, requestedStr, busy)] });
    }

    const rangeEnd = new Date(todayAnchor.getTime() + ROLLING_DAYS_AHEAD * 24 * 60 * 60 * 1000);
    const busy = await getBusyRanges(todayAnchor, rangeEnd);

    const days = [];
    for (let i = 0; i < ROLLING_DAYS_AHEAD; i++) {
      const anchorDate = new Date(todayAnchor);
      anchorDate.setUTCDate(todayAnchor.getUTCDate() + i);
      const dateStr = `${anchorDate.getUTCFullYear()}-${pad2(anchorDate.getUTCMonth() + 1)}-${pad2(anchorDate.getUTCDate())}`;
      days.push(slotsForDay(anchorDate, dateStr, busy));
    }

    res.json({ days, maxDate: (() => {
      const d = new Date(todayAnchor.getTime() + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000);
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    })(), minDate: todayStr });
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
      try {
        await updateBookingDeal(dealId, dealInput, STAGE_NEW);
      } catch (err) {
        // ФИКС "Bitrix24 crm.deal.update: HTTP 400 — Not found": локально мы помним
        // dealId как "активную" сделку клиента, но в самом Битриксе её больше нет
        // (удалили руками при тестах, или она вообще не создалась из-за более ранней
        // ошибки) — update на несуществующий ID падает и ложится всей записью.
        // Вместо того чтобы блокировать бронирование протухшей ссылкой — считаем
        // сделку потерянной и создаём новую, как для нового клиента.
        const notFound = err.httpStatus === 400 || err.httpStatus === 404
          || /not found/i.test(err.message || '');
        if (!notFound) throw err;
        console.warn(`⚠️  Сделка #${dealId} из activeBookingByChat не найдена в Битриксе — создаю новую взамен`);
        dealId = await createBookingDeal(dealInput);
      }
      await removeCalendarEvent(existing.calendarEventId).catch(() => {});
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

    // ФИКС "напоминание пришло не в то время / показывает не тот час":
    // deal.BEGINDATE — это то, что crm.deal.get ОТДАЁТ обратно, а не то, что мы сами
    // туда положили. Bitrix не всегда возвращает его в чистом ISO+смещение — иногда
    // это классический битриксовский "ДД.ММ.ГГГГ ЧЧ:ММ:СС". `new Date(beginDate)`
    // в таком случае либо даёт Invalid Date, либо (что хуже и незаметнее) JS
    // интерпретирует строку по каким-то своим догадкам — и именно так время "уезжает"
    // на несколько часов. Используем тот же терпимый парсер, что и для календаря.
    const dt = parseBitrixDateTime(deal.BEGINDATE, ORG_TIMEZONE);
    if (!dt) {
      console.error('Не удалось разобрать BEGINDATE сделки:', dealId, deal.BEGINDATE);
      return res.status(422).json({ error: 'bad_begindate' });
    }
    // Храним КАНОНИЧЕСКИЙ UTC ISO (dt.toISOString()), а не сырую строку от Битрикса.
    // Тогда cron ниже, который делает new Date(booking.dateTime), больше не зависит
    // от того, в каком формате Битрикс отдал дату — он всегда получает однозначный UTC.
    const dateTimeKey = dt.toISOString();

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

// ФИКС "напоминание пришло дважды": флаг sentMorning/sentHour раньше выставлялся
// ПОСЛЕ отправки. Если один тик крона ещё не успел записать флаг (сеть до
// Telegram/Mongo подтормозила), а следующий тик (через минуту) уже стартовал —
// оба видят sentHour:false и оба шлют сообщение. Плюс отдельная защита от
// НАЛОЖЕНИЯ самих тиков крона, если целый проход не уложился в минуту.
let reminderTickRunning = false;

// Атомарно "забираем" право на отправку этого напоминания: обновляем флаг только
// если он ещё false, и отправляем сообщение только если реально забрали именно мы.
async function claimAndSend(booking, kind) {
  const field = kind === 'morning' ? 'sentMorning' : 'sentHour';
  // mongodb driver v6: findOneAndUpdate возвращает сам документ (или null, если
  // ни один не подошёл под фильтр) — без обёртки {value}, как было в старых версиях.
  const claimed = await db.collection('confirmedBookings').findOneAndUpdate(
    { dealId: booking.dealId, [field]: false },
    { $set: { [field]: true } },
  );
  if (!claimed) return; // кто-то (другой тик) уже забрал это напоминание — не шлём второй раз
  await sendReminder(booking, kind);
}

cron.schedule('* * * * *', async () => {
  if (!db) return;
  if (reminderTickRunning) return; // предыдущий проход ещё не закончился — пропускаем этот тик
  reminderTickRunning = true;
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
        await claimAndSend(booking, 'morning');
      }

      // Напоминание №2: от "за час до начала" и до самого начала встречи
      if (!booking.sentHour && time >= hourBeforeStr && time < classTimeStr) {
        await claimAndSend(booking, 'hour');
      }
    }
  } catch (err) {
    console.error('Ошибка планировщика напоминаний:', err);
  } finally {
    reminderTickRunning = false;
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
