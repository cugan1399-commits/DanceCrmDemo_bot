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
  notifyManagerAboutEscalation,
  moveDealToEscalationStage,
  addDealComment,
  getDealsWithManagerReply,
  clearManagerReplyField,
  BITRIX_TG_FIELD_NAME,
  BITRIX_MANAGER_REPLY_FIELD_NAME,
  ORG_TIMEZONE,
} from './bitrix.js';
import { handleUserMessage, isStopWordTrigger, loadHistory } from './ai.js';
import { ensureContact, getActiveDealIfOpen, setActiveDeal } from './contacts.js';

// Отдельный от встречи и от интереса к товару кеш "активной сделки" — см.
// подробный комментарий у getActiveDealIfOpen в contacts.js про то, почему у
// каждого типа обращения (встреча / интерес к товару / эскалация) своя коллекция,
// а не одна общая.
const ESCALATION_DEAL_COLLECTION = 'activeEscalationDealByChat';
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
  // ИСТОЧНИК ИСТИНЫ по времени встречи — то, что мы САМИ вычислили при бронировании
  // (fromDate), а не то, что Битрикс потом отдаёт обратно через crm.deal.get.
  // Причина: TITLE сделки в Битриксе строится из этого же fromDate и показывает
  // ВЕРНОЕ время (это подтверждено — в самой сделке время правильное), а вот
  // deal.BEGINDATE, возвращаемый API при повторном чтении, у некоторых порталов
  // Битрикс24 приходит в другом часовом поясе/формате и "не тот час" ловится именно
  // здесь. Поэтому напоминания и подтверждения теперь берут время ИЗ ЭТОЙ таблицы,
  // а не из ответа Битрикса — так баг с некорректным часом устраняется полностью,
  // а не только чинится парсинг очередного формата даты.
  await db.collection('dealBookingInfo').createIndex({ dealId: 1 }, { unique: true });
  // Ровно одна "живая" сделка ВСТРЕЧИ на chatId — на ней держится защита от дублей при переносе времени.
  await db.collection('activeBookingByChat').createIndex({ chatId: 1 }, { unique: true });
  // Ровно одна "живая" сделка ИНТЕРЕСА К ТОВАРУ на chatId — своя, отдельная от встречи
  // (см. logProductInterestToDeal в ai.js и комментарий у getActiveDealIfOpen в contacts.js).
  await db.collection('activeInterestDealByChat').createIndex({ chatId: 1 }, { unique: true });
  // Ровно одна "живая" сделка-ЭСКАЛАЦИЯ на chatId — тоже своя, отдельная от двух выше.
  await db.collection('activeEscalationDealByChat').createIndex({ chatId: 1 }, { unique: true });
  // Состояние ИИ-консультанта по чату: { chatId, aiActive, updatedAt }.
  // aiActive=true по умолчанию — на новые чаты отвечает ИИ, пока его не выключит
  // либо стоп-слово клиента, либо сама модель через escalate_to_human, либо менеджер вручную.
  await db.collection('aiChatStatus').createIndex({ chatId: 1 }, { unique: true });
  // История диалога с ИИ по чату (для контекста между сообщениями) — см. ai.js.
  await db.collection('aiConversations').createIndex({ chatId: 1 }, { unique: true });
  // Кеш "chatId -> ID карточки клиента (Contact) в Битриксе" — см. contacts.js.
  await db.collection('contactByChat').createIndex({ chatId: 1 }, { unique: true });
  // ФИКС "дублирующиеся ответы бота": Telegram повторно шлёт тот же update, если
  // вебхук не ответил 200 достаточно быстро (например, сервер только проснулся
  // после сна на бесплатном Render-инстансе, и обработка ИИ+Bitrix заняла слишком
  // много времени). См. app.post(TELEGRAM_WEBHOOK_PATH) ниже — там теперь 200
  // отдаётся сразу, а сюда пишется updateId для дедупликации ДАЖЕ таких легитимных
  // повторов. expireAfterSeconds — запись живёт 10 минут, дольше Telegram повторы
  // всё равно не присылает, и коллекция не растёт бесконечно.
  await db.collection('processedUpdates').createIndex({ updateId: 1 }, { unique: true });
  await db.collection('processedUpdates').createIndex({ createdAt: 1 }, { expireAfterSeconds: 600 });
  console.log('✅ MongoDB подключена');
}
connectDB().catch(err => console.error('❌ Ошибка MongoDB:', err));

// ===================== Состояние ИИ-консультанта по чату =====================

// По умолчанию (для ещё не встречавшихся chatId) ИИ активен — см. п.1 ТЗ.
async function isAiActive(chatId) {
  if (!db) return true;
  const doc = await db.collection('aiChatStatus').findOne({ chatId });
  return doc ? doc.aiActive !== false : true;
}

async function setAiActive(chatId, aiActive) {
  if (!db) return;
  await db.collection('aiChatStatus').updateOne(
    { chatId },
    { $set: { chatId, aiActive, updatedAt: new Date() } },
    { upsert: true },
  );
}

// Собираем последние несколько сообщений диалога (см. aiConversations в ai.js) в
// короткий читаемый текст — чтобы менеджер, открыв сделку в Битриксе, сразу видел
// контекст, а не только голую причину эскалации.
function formatRecentHistory(messages) {
  if (!messages || !messages.length) return null;
  return messages
    .filter(m => m.role === 'user' || (m.role === 'assistant' && m.content))
    .slice(-6)
    .map(m => `${m.role === 'user' ? 'Клиент' : 'ИИ'}: ${String(m.content).slice(0, 300)}`)
    .join('\n');
}

// Общая точка выключения ИИ + уведомления менеджера — вызывается и из стоп-слов,
// и из ответа модели (escalate_to_human), поэтому вынесена отдельно.
//
// Если у клиента уже есть НЕЗАКРЫТАЯ сделка-эскалация (см. ESCALATION_DEAL_COLLECTION
// и getActiveDealIfOpen в contacts.js) — эскалация просто логируется комментарием в
// неё, вторая сделка не создаётся. Если активной эскалации нет (первое обращение)
// или прошлая уже завершена (клиент написал спустя время после закрытой сделки) —
// создаётся новая. ВАЖНО: это отдельный от встречи и от интереса к товару кеш —
// эскалация никогда не цепляется за сделку встречи/покупки, только за свою же
// предыдущую эскалацию, если та ещё не закрыта.
//
// ФИКС "у одного клиента расползается 2-3 карточки (встреча/интерес/эскалация)":
// раньше эскалация ВСЕГДА заводила свою отдельную сделку (или дописывала в
// предыдущую такую же). Теперь порядок другой: если у чата уже есть открытая
// сделка ЛЮБОГО типа (встреча или интерес к товару) — используем именно её,
// просто переводим в стадию "Требуется вмешательство менеджера" и комментируем.
// Отдельная сделка-эскалация заводится только тогда, когда у клиента вообще
// ничего ещё не было (например, он сразу с порога попросил менеджера) — тогда
// показать менеджеру и правда больше нечего, кроме этой карточки.
async function escalateToHuman(chatId, reason, username) {
  await setAiActive(chatId, false);
  try {
    const history = await loadHistory(db, chatId);
    const recentHistoryText = formatRecentHistory(history);
    const commentText = [
      '⚠️ ИИ передал чат менеджеру',
      `Причина: ${reason || 'не указана'}`,
      recentHistoryText ? `\nПоследние сообщения:\n${recentHistoryText}` : null,
    ].filter(Boolean).join('\n');

    // 1) Эту же самую эскалацию этого чата уже поднимали раньше — просто дописываем.
    let dealId = await getActiveDealIfOpen({ db, chatId, collection: ESCALATION_DEAL_COLLECTION });

    // 2) Эскалации своей ещё не было, но есть открытая карточка встречи или интереса —
    // переиспользуем её вместо того, чтобы плодить третью.
    if (!dealId) {
      dealId = await getActiveDealIfOpen({ db, chatId, collection: 'activeBookingByChat' })
        || await getActiveDealIfOpen({ db, chatId, collection: 'activeInterestDealByChat' });
    }

    if (dealId) {
      await addDealComment(dealId, commentText);
      // Возвращаем сделку в стадию "Требуется вмешательство менеджера" — если
      // менеджер уже успел подвинуть её дальше по воронке (или это была карточка
      // встречи/интереса на своей стадии), новая порция внимания не должна
      // затеряться в уже "обработанной" колонке.
      await moveDealToEscalationStage(dealId).catch(err => {
        console.error(`Не удалось перевести сделку #${dealId} в стадию эскалации:`, err.message);
      });
      // Запоминаем именно эту сделку как "активную эскалацию" чата — при следующей
      // эскалации (см. п.1) найдём её сразу, не будем искать по другим коллекциям.
      await setActiveDeal({ db, chatId, dealId, collection: ESCALATION_DEAL_COLLECTION });
      console.log(`📋 Эскалация записана в существующую карточку #${dealId} для chatId ${chatId} (${reason})`);
    } else {
      // 3) У клиента вообще нет ни одной открытой карточки — заводим новую.
      const contactId = await ensureContact({ db, chatId, username }).catch(err => {
        console.error('Не удалось найти/создать карточку клиента для эскалации:', err.message);
        return null;
      });
      dealId = await notifyManagerAboutEscalation({ chatId, reason, recentHistoryText, contactId });
      await setActiveDeal({ db, chatId, dealId, collection: ESCALATION_DEAL_COLLECTION });
      console.log(`📋 Создана новая сделка-эскалация #${dealId} для chatId ${chatId} (${reason})`);
    }
  } catch (err) {
    console.error('Не удалось уведомить менеджера в Битриксе:', err.message);
  }
  await sendMessage(chatId, '👤 Передаю ваш вопрос менеджеру — он подключится к чату в ближайшее время.');
}

// ===================== Telegram helpers =====================

function sendMessage(chatId, text, keyboard) {
  const data = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) data.reply_markup = keyboard;
  return axios.post(`${API}/sendMessage`, data);
}

// Отправка фото товара (см. send_product_photo в ai.js). Мы САМИ скачиваем файл с
// Битрикса и заливаем байты в Telegram (multipart), а не отдаём Telegram ссылку на
// скачивание "как есть" — потому что в этой ссылке зашит токен нашего входящего
// вебхука Битрикса, светить его перед серверами Telegram не хочется, плюс так
// надёжнее (Telegram не всегда может дотянуться до "внутренних" REST-эндпоинтов CRM).
// Требует Node 18+ (глобальные fetch/FormData/Blob) — на Render это по умолчанию так.
async function sendPhotoFromUrl(chatId, photoUrl, caption) {
  const { data: imageBuffer } = await axios.get(photoUrl, { responseType: 'arraybuffer' });
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('photo', new Blob([imageBuffer]), 'product.jpg');
  const res = await fetch(`${API}/sendPhoto`, { method: 'POST', body: form });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram sendPhoto: HTTP ${res.status} — ${body}`);
  }
  return res.json();
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

    // Одна карточка клиента на chatId, независимо от того, обращался ли он раньше
    // через ИИ-консультанта (см. logProductInterestToDeal в ai.js) или впервые
    // пришёл сразу записываться — вторая ветка тоже даёт этому же контакту имя/телефон.
    const contactId = await ensureContact({ db, chatId: user.id, username: user.username, name, phone }).catch(err => {
      console.error('Не удалось найти/создать карточку клиента для записи на встречу:', err.message);
      return null;
    });

    const dealInput = {
      contactId,
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
      // Наш собственный источник истины по времени встречи для этой сделки —
      // см. комментарий у createIndex('dealBookingInfo') в connectDB().
      await db.collection('dealBookingInfo').updateOne(
        { dealId: String(dealId) },
        { $set: { dealId: String(dealId), chatId: user.id, dateTime: fromDate.toISOString(), topic, name } },
        { upsert: true },
      );
    }

    // ФИКС "непонятно, отправилась ли заявка": раньше об этом сообщал только текст
    // в самом мини-приложении — если пользователь его быстро закрыл, в чате бота
    // не оставалось никакого следа. Теперь дублируем это отдельным сообщением в чат
    // сразу при создании/переносе заявки — и для первой записи, и для переноса.
    await sendMessage(
      user.id,
      existing
        ? `📩 Новая заявка на ${humanTime(fromDate)} отправлена! Ждите подтверждения в этом чате.`
        : `📩 Заявка на ${humanTime(fromDate)} отправлена! Ждите подтверждения в этом чате.`,
    ).catch(err => console.error('Не удалось отправить сообщение "заявка отправлена":', err.message));

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
    const ownRecord = db ? await db.collection('dealBookingInfo').findOne({ dealId: String(dealId) }) : null;
    const chatId = ownRecord?.chatId || Number(deal[BITRIX_TG_FIELD_NAME]);
    if (!chatId) return res.status(422).json({ error: 'no_telegram_id_on_deal' });

    // ФИКС "напоминание/подтверждение показывает не тот час": TITLE сделки в Битриксе
    // строится из нашего же fromDate и показывает ВЕРНОЕ время — то есть проблема не
    // в том, что мы отправляем, а в том, что deal.BEGINDATE при обратном чтении через
    // crm.deal.get у некоторых порталов Битрикс24 приходит уже не тем значением/поясом.
    // Поэтому больше не берём время встречи из ответа Битрикса как источник истины —
    // берём его из dealBookingInfo, куда сами положили точное значение ещё в /api/book.
    // deal.BEGINDATE используется только как запасной вариант для очень старых сделок,
    // созданных ДО этого фикса (когда своей записи ещё не было) — и логируем оба
    // значения, чтобы при следующем расхождении сразу было видно, что именно Битрикс
    // возвращает не то, что мы туда клали.
    let dt;
    if (ownRecord) {
      dt = new Date(ownRecord.dateTime);
      console.log(`📥 [dealId ${dealId}] время встречи взято из своей БД: ${humanTime(dt)} (сырое поле Битрикса BEGINDATE для сравнения: ${deal.BEGINDATE})`);
    } else {
      dt = parseBitrixDateTime(deal.BEGINDATE, ORG_TIMEZONE);
      console.warn(`⚠️  [dealId ${dealId}] своей записи о времени нет (старая сделка?) — приходится доверять Битриксу. BEGINDATE=${deal.BEGINDATE}`);
      if (!dt) {
        console.error('Не удалось разобрать BEGINDATE сделки:', dealId, deal.BEGINDATE);
        return res.status(422).json({ error: 'bad_begindate' });
      }
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

// ===================== Авто-возврат ИИ после паузы менеджера =====================
//
// "Навсегда молчит, пока не включат вручную" — неудобно и для теста, и в бою
// (менеджер может просто забыть вернуть ИИ обратно). Вместо этого: если с момента
// ПОСЛЕДНЕГО действия менеджера/эскалации (aiChatStatus.updatedAt) прошло
// AI_AUTO_RESUME_MINUTES — ИИ включается сам.
//
// Почему можно опираться на updatedAt, ничего больше не храня: setAiActive(false)
// вызывается и при самой эскалации, и при каждом ответе менеджера — что через
// /api/manager/reply, что через опрос поля сделки (pollManagerReplies выше). То
// есть updatedAt и так уже "время последнего события со стороны менеджера" — пока
// менеджер отвечает, таймер сам постоянно сдвигается вперёд и не срабатывает;
// сработает только тогда, когда менеджер реально перестал писать.
//
// AI_AUTO_RESUME_MINUTES=0 (или не задан) — функция выключена, поведение как раньше.
const AI_AUTO_RESUME_MINUTES = Number(process.env.AI_AUTO_RESUME_MINUTES || 60);
let autoResumeTickRunning = false;

cron.schedule('* * * * *', async () => {
  if (!db || !AI_AUTO_RESUME_MINUTES) return;
  if (autoResumeTickRunning) return; // предыдущий проход ещё не закончился — пропускаем этот тик
  autoResumeTickRunning = true;
  try {
    const cutoff = new Date(Date.now() - AI_AUTO_RESUME_MINUTES * 60 * 1000);
    const stale = await db.collection('aiChatStatus')
      .find({ aiActive: false, updatedAt: { $lte: cutoff } })
      .toArray();

    for (const doc of stale) {
      // Та же атомарная "заявка на право включить" через findOneAndUpdate с условием
      // в фильтре, что и у напоминаний (claimAndSend выше) — если несколько тиков
      // вдруг наложатся, сообщение клиенту уйдёт только один раз.
      const claimed = await db.collection('aiChatStatus').findOneAndUpdate(
        { chatId: doc.chatId, aiActive: false, updatedAt: { $lte: cutoff } },
        { $set: { aiActive: true, updatedAt: new Date() } },
      );
      if (!claimed) continue;

      await sendMessage(doc.chatId, '🤖 Снова на связи — чем могу помочь?').catch(err =>
        console.error(`Не удалось отправить сообщение об авто-возврате ИИ (chatId ${doc.chatId}):`, err.message)
      );
      console.log(`🤖 ИИ автоматически включён обратно для chatId ${doc.chatId} (менеджер молчал ${AI_AUTO_RESUME_MINUTES} мин.)`);
    }
  } catch (err) {
    console.error('Ошибка авто-включения ИИ:', err.message);
  } finally {
    autoResumeTickRunning = false;
  }
});

// ===================== Ответ менеджера прямо из поля сделки =====================
//
// Менеджер открывает сделку в Битриксе, пишет текст в поле "Ответ клиенту в
// Телеграм" и сохраняет карточку. Раз в POLL_INTERVAL секунд бот сам проверяет
// через crm.deal.list, у каких сделок это поле не пустое, отправляет текст
// клиенту в Telegram, гасит ИИ для этого чата (чтобы не отвечал поверх менеджера)
// и очищает поле — чтобы то же сообщение не ушло повторно на следующем тике.
//
// Требует BITRIX_MANAGER_REPLY_FIELD_NAME в .env — это КОД поля (например
// UF_CRM_1690000000000), а не подпись "Ответ клиенту в Телеграм", которую видно
// в интерфейсе. Код можно посмотреть, открыв в браузере
// <URL_ВХОДЯЩЕГО_ВЕБХУКА>/crm.deal.fields.json и найдя там формулу с formLabel,
// равным подписи поля.
const MANAGER_REPLY_POLL_SECONDS = Number(process.env.MANAGER_REPLY_POLL_SECONDS || 20);
let managerReplyTickRunning = false; // та же защита от наложения тиков, что и у напоминаний выше

async function resolveChatIdForDeal(dealId, deal) {
  const info = db ? await db.collection('dealBookingInfo').findOne({ dealId: String(dealId) }) : null;
  if (info?.chatId) return info.chatId;
  const fromField = BITRIX_TG_FIELD_NAME ? Number(deal[BITRIX_TG_FIELD_NAME]) : null;
  return fromField || null;
}

async function pollManagerReplies() {
  if (!BITRIX_MANAGER_REPLY_FIELD_NAME) return;
  if (managerReplyTickRunning) return;
  managerReplyTickRunning = true;
  try {
    const deals = await getDealsWithManagerReply();
    for (const deal of deals) {
      const dealId = deal.ID;
      const text = deal[BITRIX_MANAGER_REPLY_FIELD_NAME];
      if (!text || !String(text).trim()) continue;

      try {
        const chatId = await resolveChatIdForDeal(dealId, deal);
        if (!chatId) {
          console.warn(`⚠️  Сделка #${dealId}: не удалось определить chatId клиента — поле оставляю как есть, чтобы не потерять текст`);
          continue;
        }

        await sendMessage(chatId, text);
        await setAiActive(chatId, false); // менеджер вступил в разговор — ИИ молчит

        // Чистим поле только ПОСЛЕ успешной отправки: если это упадёт, на следующем
        // тике мы просто попробуем снова с тем же текстом (сообщение клиенту при
        // этом уже точно ушло один раз — риск дубля лучше риска потери текста).
        await clearManagerReplyField(dealId).catch(err =>
          console.error(`Не удалось очистить поле ответа у сделки #${dealId} (сообщение уже отправлено, возможен дубль на след. тике):`, err.message)
        );

        addDealComment(dealId, `👤 Менеджер ответил клиенту: ${text}`).catch(err =>
          console.error(`Не удалось залогировать ответ менеджера в таймлайн сделки #${dealId}:`, err.message)
        );

        console.log(`✉️  Ответ менеджера по сделке #${dealId} отправлен в Telegram (chatId ${chatId})`);
      } catch (err) {
        console.error(`Ошибка отправки ответа менеджера по сделке #${dealId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Ошибка опроса поля "Ответ клиенту в Телеграм" в Битриксе:', err.message);
  } finally {
    managerReplyTickRunning = false;
  }
}

cron.schedule(`*/${MANAGER_REPLY_POLL_SECONDS} * * * * *`, pollManagerReplies);

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

// Обычный текст (не команда, не нажатие инлайн-кнопки) — передаём ИИ-консультанту,
// если он включён для этого чата. Если выключен (менеджер держит диалог руками) —
// молча ничего не делаем, чтобы не мешать живой переписке; сам ИИ вернётся, когда
// менеджер надолго замолчит (см. крон авто-возврата выше) либо когда его включат
// вручную через /api/manager/resume-ai.
async function handleAiText(chatId, text, username) {
  // Быстрый путь: стоп-слова клиента распознаём без обращения к модели.
  if (isStopWordTrigger(text)) {
    await escalateToHuman(chatId, 'клиент написал стоп-слово ("оператор"/"менеджер"/"человек")', username);
    return;
  }

  const active = await isAiActive(chatId);
  if (!active) return; // менеджер уже ведёт чат руками — ИИ молчит

  try {
    const { replyText, escalate, escalateReason, photoUrl } = await handleUserMessage({ db, chatId, userText: text, username });
    if (photoUrl) {
      await sendPhotoFromUrl(chatId, photoUrl).catch(err => {
        console.error('Не удалось отправить фото товара в Telegram:', err.message);
      });
    }
    if (replyText) await sendMessage(chatId, replyText);
    if (escalate) await escalateToHuman(chatId, escalateReason, username);
  } catch (err) {
    console.error('Ошибка ИИ-консультанта:', err.message);
    await sendMessage(chatId, 'Извините, техническая заминка. Уже зову менеджера.').catch(() => {});
    await escalateToHuman(chatId, 'техническая ошибка при обращении к ИИ', username);
  }
}

// ФИКС "дубли сообщений от бота": раньше res.sendStatus(200) отправлялся ТОЛЬКО
// после await всей обработки (модель + Bitrix), поэтому при медленном ответе
// (холодный старт, заминка ИИ) Telegram решал, что вебхук не сработал, и слал тот
// же update повторно — бот отвечал дважды на одно сообщение. Теперь: 1) сразу
// отвечаем 200, чтобы Telegram точно не ретраил по таймауту; 2) обработку уводим
// в фон; 3) на случай, если Telegram всё равно продублирует update по своим
// причинам, отбрасываем повтор по update.update_id (см. processedUpdates выше).
app.post(TELEGRAM_WEBHOOK_PATH, async (req, res) => {
  const update = req.body;
  res.sendStatus(200);

  try {
    if (update.update_id !== undefined && db) {
      try {
        await db.collection('processedUpdates').insertOne({ updateId: update.update_id, createdAt: new Date() });
      } catch (err) {
        if (err.code === 11000) return; // уже обработали этот update — выходим молча
        console.error('Не удалось записать updateId для дедупликации (обрабатываю как обычно):', err.message);
      }
    }

    if (update.callback_query) {
      await handleReminderCallback(update.callback_query);
      return;
    }
    const text = update.message?.text;
    const chatId = update.message?.chat?.id;
    const username = update.message?.from?.username;
    if (text === '/start') {
      await sendMessage(
        chatId,
        '👋 Привет! Открой мини-приложение кнопкой снизу, чтобы посмотреть свободное время и записаться на встречу, или просто напиши вопрос — отвечу.'
      );
    } else if (text && chatId) {
      await handleAiText(chatId, text, username);
    }
  } catch (err) {
    console.error('Ошибка Telegram webhook:', err);
  }
});

// ===================== Ручное включение ИИ менеджером =====================
//
// POST /api/manager/resume-ai  { chatId }  header: X-Manager-Token: <MANAGER_API_TOKEN>
// Временный эндпоинт для кнопки в Битриксе/админке — включает ИИ обратно после того,
// как менеджер закончил ручную переписку. Токен сравнивается строкой, не для продакшена
// без HTTPS + более серьёзной авторизации, но для демо/временного использования достаточно.
const MANAGER_API_TOKEN = process.env.MANAGER_API_TOKEN || null;

app.post('/api/manager/resume-ai', async (req, res) => {
  const token = req.header('X-Manager-Token') || req.query.token || req.body?.token;
  if (!MANAGER_API_TOKEN || token !== MANAGER_API_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const chatId = req.body?.chatId ?? req.query.chatId;
  if (chatId === undefined) return res.status(400).json({ error: 'no_chat_id' });

  await setAiActive(Number(chatId) || chatId, true);
  await sendMessage(Number(chatId) || chatId, '🤖 Снова на связи — чем могу помочь?').catch(() => {});
  res.json({ ok: true });
});

// ===================== Лёгкий релей "менеджер -> клиент в Telegram" =====================
//
// POST /api/manager/reply  { dealId? , chatId?, text }  header: X-Manager-Token: <MANAGER_API_TOKEN>
// Принимает ЛИБО dealId (тогда chatId ищем сами — сначала в своей БД, как в /webhook/bitrix,
// потом как запасной вариант читаем поле с телеграм-ID прямо из сделки), ЛИБО готовый chatId.
// Выключает ИИ для этого чата (чтобы не отвечал поверх менеджера) и логирует ответ в
// таймлайн сделки — тем же способом, что и вопросы клиента к ИИ (см. ai.js).
app.post('/api/manager/reply', async (req, res) => {
  const token = req.header('X-Manager-Token') || req.query.token || req.body?.token;
  if (!MANAGER_API_TOKEN || token !== MANAGER_API_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const text = req.body?.text;
  const dealId = req.body?.dealId ?? req.query.dealId;
  let chatId = req.body?.chatId ?? req.query.chatId;
  if (!text) return res.status(400).json({ error: 'no_text' });
  if (!chatId && !dealId) return res.status(400).json({ error: 'no_chat_id_or_deal_id' });

  try {
    if (!chatId) {
      const info = db ? await db.collection('dealBookingInfo').findOne({ dealId: String(dealId) }) : null;
      if (info) {
        chatId = info.chatId;
      } else {
        const deal = await getDeal(dealId);
        chatId = Number(deal[BITRIX_TG_FIELD_NAME]);
      }
    }
    if (!chatId) return res.status(422).json({ error: 'chat_id_not_found' });
    chatId = Number(chatId) || chatId;

    await setAiActive(chatId, false);
    await sendMessage(chatId, text);

    // Логируем ответ менеджера в таймлайн той же сделки, что и вопросы к ИИ (см. ai.js) —
    // dealId либо пришёл явно, либо достаём его из activeBookingByChat по chatId.
    try {
      const resolvedDealId = dealId || (db ? (await db.collection('activeBookingByChat').findOne({ chatId }))?.dealId : null);
      if (resolvedDealId) await addDealComment(resolvedDealId, `👤 Менеджер ответил клиенту: ${text}`);
    } catch (err) {
      console.error('Не удалось залогировать ответ менеджера в сделку:', err.message);
    }

    res.json({ ok: true, chatId });
  } catch (err) {
    console.error('Ошибка отправки ответа менеджера:', err.message);
    res.status(502).json({ error: 'send_failed' });
  }
});

// GET /manager — простая HTML-форма для ручного ответа клиенту в Telegram прямо из
// браузера (без сборки фронтенда). Токен хранится только в браузере менеджера, на
// сервере не логируется. Для демо-проекта достаточно; для продакшена стоит поставить
// нормальную авторизацию поверх этой страницы (например, Basic Auth на уровне Express).
app.get('/manager', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ответ клиенту в Telegram</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px; }
  label { display: block; margin-top: 16px; font-weight: 600; }
  input, textarea { width: 100%; padding: 8px; margin-top: 4px; box-sizing: border-box; font-size: 16px; }
  textarea { min-height: 100px; }
  button { margin-top: 20px; padding: 10px 20px; font-size: 16px; cursor: pointer; }
  #status { margin-top: 12px; font-weight: 600; }
</style>
</head>
<body>
  <h2>Ответ клиенту в Telegram</h2>
  <label>Токен менеджера
    <input id="token" type="password" placeholder="MANAGER_API_TOKEN">
  </label>
  <label>ID сделки в Битриксе
    <input id="dealId" type="text" placeholder="например, 35">
  </label>
  <label>Сообщение клиенту
    <textarea id="text" placeholder="Введите ответ..."></textarea>
  </label>
  <button onclick="sendReply()">Отправить в Telegram</button>
  <div id="status"></div>

<script>
async function sendReply() {
  const token = document.getElementById('token').value.trim();
  const dealId = document.getElementById('dealId').value.trim();
  const text = document.getElementById('text').value.trim();
  const statusEl = document.getElementById('status');
  if (!token || !dealId || !text) {
    statusEl.textContent = 'Заполните все поля.';
    statusEl.style.color = 'red';
    return;
  }
  statusEl.textContent = 'Отправляю...';
  statusEl.style.color = 'black';
  try {
    const res = await fetch('/api/manager/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Manager-Token': token },
      body: JSON.stringify({ dealId, text }),
    });
    const data = await res.json();
    if (res.ok) {
      statusEl.textContent = 'Отправлено!';
      statusEl.style.color = 'green';
      document.getElementById('text').value = '';
    } else {
      statusEl.textContent = 'Ошибка: ' + (data.error || res.status);
      statusEl.style.color = 'red';
    }
  } catch (err) {
    statusEl.textContent = 'Ошибка сети: ' + err.message;
    statusEl.style.color = 'red';
  }
}
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Демо-сервер (Битрикс24) запущен на порту ${PORT}`));
