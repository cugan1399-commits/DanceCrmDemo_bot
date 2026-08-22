// ai.js — ИИ-консультант поверх Telegram-чата: Function Calling (OpenAI-совместимый
// протокол) + инструменты, которые дергают Битрикс24 через bitrixCall/getDeal.
//
// Почему OpenAI-совместимый протокол, а не нативный Gemini SDK:
// и Google AI Studio (эндпоинт .../v1beta/openai/chat/completions), и OpenRouter
// говорят на одном и том же "OpenAI chat.completions + tools" языке. Взяв его за
// основу, весь код агента (история диалога, разбор tool_calls, цикл "вызвал
// функцию -> вернул результат -> получил финальный ответ") не меняется вообще —
// меняются только AI_BASE_URL / AI_API_KEY / AI_MODEL в .env. Хотите нативный
// Gemini REST (functionDeclarations) — это отдельный формат ответа, здесь не
// используется, чтобы не поддерживать два разных парсера параллельно.
//
// Переменные окружения:
//   AI_BASE_URL   — по умолчанию OpenRouter: https://openrouter.ai/api/v1
//                    для прямого Gemini через Google AI Studio поставьте
//                    https://generativelanguage.googleapis.com/v1beta/openai
//   AI_API_KEY    — ключ OpenRouter или Google AI Studio (в зависимости от AI_BASE_URL)
//   AI_MODEL      — напр. 'openrouter/free' (авто-роутер OpenRouter — сам выбирает
//                    бесплатную модель с поддержкой tool calling; бесплатные модели
//                    на OpenRouter регулярно ротируются/снимаются с публикации,
//                    поэтому жёстко прибитый ID вроде 'google/gemini-...:free' рано
//                    или поздно начинает падать с 404 — 'openrouter/free' переживает
//                    это автоматически) или прямой ID модели через Google AI Studio,
//                    напр. 'gemini-2.0-flash'
//   AI_MAX_HISTORY_MESSAGES — сколько последних сообщений диалога держим в контексте (по умолчанию 16)

import axios from 'axios';
import { bitrixCall, getDeal, addDealComment, createInterestDeal, ORG_TIMEZONE } from './bitrix.js';
import { ensureContact, getActiveDealIfOpen, setActiveDeal } from './contacts.js';

// Отдельный от встречи (activeBookingByChat в index.js) кеш "активной сделки" —
// см. подробный комментарий у getActiveDealIfOpen в contacts.js про то, почему
// их нельзя было делить на одну коллекцию.
const INTEREST_DEAL_COLLECTION = 'activeInterestDealByChat';

const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const AI_API_KEY = process.env.AI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'openrouter/free';
const AI_MAX_HISTORY_MESSAGES = Number(process.env.AI_MAX_HISTORY_MESSAGES || 16);

if (!AI_API_KEY) {
  console.warn('⚠️  AI_API_KEY не задан — ИИ-консультант отвечать не сможет (обычные текстовые сообщения будут падать в тишину)');
}

// Стадии сделки -> понятный клиенту текст. Собрано из тех же ENV-переменных стадий,
// что уже используются в index.js/bitrix.js — если поменяете ID стадий там, ничего
// менять здесь не нужно, это просто маппинг "какой ID -> что сказать человеку".
function stageToHumanText(stageId) {
  const STAGE_NEW = process.env.BITRIX_NEW_STAGE_ID || 'NEW';
  const STAGE_CONFIRMED = process.env.BITRIX_CONFIRMED_STAGE_ID || 'PREPARATION';
  const STAGE_CANCELLED = process.env.BITRIX_CANCELLED_STAGE_ID || 'LOSE';
  const STAGE_VISIT_CONFIRMED = process.env.BITRIX_VISIT_CONFIRMED_STAGE_ID || STAGE_CONFIRMED;

  const map = {
    [STAGE_NEW]: 'заявка создана, ожидает подтверждения администратором',
    [STAGE_CONFIRMED]: 'встреча подтверждена',
    [STAGE_VISIT_CONFIRMED]: 'клиент подтвердил, что придёт на встречу',
    [STAGE_CANCELLED]: 'встреча отменена или требуется перенос времени',
  };
  return map[stageId] || `текущая стадия сделки: ${stageId}`;
}

// ---------- Авто-определение iblockId коммерческого каталога ----------
//
// catalog.product.list ОБЯЗАТЕЛЬНО требует iblockId в фильтре — без него Битрикс
// вернёт ошибку. Вместо того чтобы просить руками искать ID инфоблока в браузере,
// достаём его сами через catalog.catalog.list (список торговых каталогов портала)
// и кэшируем в памяти процесса — повторные вызовы инструмента не дёргают лишний
// раз API. Если каталогов несколько, берём тот, что помечен как основной
// (isDefault), иначе — первый в списке. Можно и жёстко задать ID через
// CATALOG_IBLOCK_ID в .env — тогда сетевой запрос вообще не понадобится.
let cachedIblockId = process.env.CATALOG_IBLOCK_ID ? Number(process.env.CATALOG_IBLOCK_ID) : null;
let iblockIdPromise = null;

async function resolveCatalogIblockId() {
  if (cachedIblockId) return cachedIblockId;
  if (iblockIdPromise) return iblockIdPromise; // несколько параллельных вызовов инструмента не должны дёргать API дважды

  iblockIdPromise = (async () => {
    const raw = await bitrixCall('catalog.catalog.list', {});
    // Формат ответа у разных версий портала отличается: либо { catalogs: [...] },
    // либо сразу массив — учитываем оба варианта.
    const catalogs = raw?.catalogs || raw || [];
    if (!catalogs.length) {
      throw new Error('в Битриксе не найдено ни одного коммерческого каталога (catalog.catalog.list вернул пусто)');
    }
    const chosen = catalogs.find(c => c.isDefault === true || c.isDefault === 'Y') || catalogs[0];
    const iblockId = Number(chosen.iblockId ?? chosen.iblock_id ?? chosen.id);
    if (!iblockId) {
      throw new Error('не удалось прочитать iblockId из ответа catalog.catalog.list');
    }
    cachedIblockId = iblockId;
    return iblockId;
  })();

  try {
    return await iblockIdPromise;
  } finally {
    iblockIdPromise = null; // следующий провал должен иметь шанс попробовать заново, а не залипнуть на отклонённом промисе
  }
}

// ---------- Инструменты (описания для модели, OpenAI tools-формат) ----------

export const AI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'check_product_catalog',
      description:
        'Поиск обуви в коммерческом каталоге Битрикс24, проверка цен, описания и доступного остатка. Обязательно вызывай этот инструмент, если клиент в Telegram спрашивает, что есть в наличии, сколько стоит конкретная модель или какие кроссовки доступны.',
      parameters: {
        type: 'object',
        properties: {
          search_query: { type: 'string', description: "Поисковый запрос клиента (например, 'Nike' или 'Adidas')" },
        },
        required: ['search_query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_my_deal_status',
      description:
        'Проверить статус текущей заявки/встречи ЭТОГО клиента (по его chatId) — используй, когда клиент спрашивает о судьбе своей записи/заказа/встречи.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description:
        'Передать диалог живому менеджеру. Вызывай, если клиент явно просит человека/оператора/менеджера, ИЛИ если ты не можешь помочь (вопрос не про каталог/запись, требует решения, которое ты принять не можешь).',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Коротко: почему передаём человеку' },
        },
        required: ['reason'],
      },
    },
  },
];

// ---------- Обработчики инструментов ----------
// Каждый обработчик получает { chatId, db } и разобранные аргументы, возвращает
// СТРОКУ — она уйдёт обратно модели как результат вызова функции (tool role).

// Коммерческий каталог Битрикс24 (catalog.product.list) — это ДРУГОЙ API, чем
// старый CRM-справочник товаров (crm.product.list): поля здесь в нижнем регистре
// (id/name/price/quantity/...), а не ID/NAME/PRICE. Раньше здесь стоял
// crm.product.list — переключено на catalog.product.list, так как реальные
// тестовые товары (Nike Air Force 1, Adidas Superstar) заведены именно в
// коммерческий каталог.
// ФИКС "цена не указана" при явно заданной цене в товаре: в коммерческом каталоге
// Битрикс24 цена — ОТДЕЛЬНАЯ сущность (метод catalog.price.*), а не поле самого
// товара, поэтому catalog.product.list физически не может её вернуть, сколько бы
// полей мы ни перечисляли в select. Нужен второй запрос — catalog.price.list — по
// найденным productId, и результат нужно склеить с товарами вручную.
async function fetchPricesByProductIds(productIds) {
  if (!productIds.length) return new Map();
  const raw = await bitrixCall('catalog.price.list', {
    select: ['productId', 'price', 'currency'],
    filter: { '@productId': productIds },
  });
  const list = raw?.prices || raw || [];
  const map = new Map();
  for (const p of list) {
    // Если у товара несколько типов цен (розница/опт), берём первую попавшуюся —
    // для этого демо-бота нам не нужно спрашивать клиента, какая именно цена нужна.
    if (!map.has(p.productId)) map.set(p.productId, p);
  }
  return map;
}

// ФИКС "менеджер не видит, о чём клиент спрашивал ИИ": каждый вопрос про товар
// логируем комментарием в таймлайн сделки этого клиента. Сделка "интерес к товару"
// живёт в СВОЁМ кеше (INTEREST_DEAL_COLLECTION), отдельном от кеша встречи — иначе
// вопрос "сколько стоят кроссовки?", заданный уже после того как клиент записался
// на встречу, ложился комментарием в сделку ВСТРЕЧИ вместо отдельной сделки по
// товару (было именно так, пока обе сделки делили одну коллекцию — см. подробности
// у getActiveDealIfOpen в contacts.js). Если у чата ещё нет открытой сделки такого
// типа — создаём новую; если есть — просто дописываем комментарий в неё, так что
// несколько вопросов подряд про разные товары не плодят сделки-дубли.
// Ошибку логирования НЕ даём проронить наружу — клиент должен получить ответ по
// каталогу в любом случае, даже если запись в Битрикс не удалась.
async function logProductInterestToDeal({ chatId, db, username, search_query, summary }) {
  if (!db || !chatId) return;
  try {
    let dealId = await getActiveDealIfOpen({ db, chatId, collection: INTEREST_DEAL_COLLECTION });
    if (!dealId) {
      const contactId = await ensureContact({ db, chatId, username }).catch(err => {
        console.error('Не удалось найти/создать карточку клиента для сделки интереса к товару:', err.message);
        return null;
      });
      dealId = await createInterestDeal({ chatId, username, contactId });
      await setActiveDeal({ db, chatId, dealId, collection: INTEREST_DEAL_COLLECTION });
    }
    await addDealComment(dealId, `🔎 Клиент спросил ИИ про товар: "${search_query}"\n${summary}`);
  } catch (err) {
    console.error('Не удалось залогировать интерес к товару в сделку:', err.message);
  }
}

async function toolCheckProductCatalog({ search_query, chatId, db, username }) {
  try {
    const iblockId = await resolveCatalogIblockId();
    const products = await bitrixCall('catalog.product.list', {
      select: ['id', 'iblockId', 'name', 'previewText', 'detailText', 'quantity'],
      filter: { iblockId, '%name': search_query }, // поиск по частичному совпадению названия
    });
    // catalog.product.list оборачивает результат в { products: [...] }
    const list = products?.products || products || [];
    if (!list.length) {
      const notFoundText = `Товары по запросу "${search_query}" в каталоге не найдены.`;
      await logProductInterestToDeal({ chatId, db, username, search_query, summary: notFoundText });
      return notFoundText;
    }
    const pricesByProductId = await fetchPricesByProductIds(list.map(p => p.id));
    const lines = list.slice(0, 8).map(p => {
      const priceEntry = pricesByProductId.get(p.id);
      const price = priceEntry ? `${priceEntry.price} ${priceEntry.currency || ''}`.trim() : 'цена не указана';
      const stock = p.quantity != null ? `, остаток: ${p.quantity} шт.` : '';
      const text = p.previewText || p.detailText;
      const desc = text ? ` — ${String(text).slice(0, 200)}` : '';
      return `• ${p.name}: ${price}${stock}${desc}`;
    });
    const resultText = `Найдено в каталоге:\n${lines.join('\n')}`;
    await logProductInterestToDeal({ chatId, db, username, search_query, summary: resultText });
    return resultText;
  } catch (err) {
    console.error('Инструмент check_product_catalog упал:', err.message);
    return 'Не удалось получить каталог из Битрикса (техническая ошибка). Предложи клиенту уточнить у менеджера.';
  }
}

async function toolCheckMyDealStatus({ chatId, db }) {
  if (!db) return 'Локальная база недоступна, не могу найти сделку клиента.';
  try {
    const active = await db.collection('activeBookingByChat').findOne({ chatId });
    if (!active) return 'У этого клиента нет активной заявки/встречи в системе.';
    const deal = await getDeal(active.dealId);
    if (!deal) return `Сделка #${active.dealId} не найдена в Битриксе.`;
    const info = await db.collection('dealBookingInfo').findOne({ dealId: String(active.dealId) });
    const whenText = info?.dateTime
      ? new Intl.DateTimeFormat('ru-RU', {
          timeZone: ORG_TIMEZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        }).format(new Date(info.dateTime))
      : null;
    return [
      `Сделка #${active.dealId}.`,
      whenText ? `Время встречи: ${whenText}.` : null,
      `Статус: ${stageToHumanText(deal.STAGE_ID)}.`,
    ].filter(Boolean).join(' ');
  } catch (err) {
    console.error('Инструмент check_my_deal_status упал:', err.message);
    return 'Не удалось проверить статус заявки (техническая ошибка). Предложи клиенту уточнить у менеджера.';
  }
}

// escalate_to_human обрабатывается ОТДЕЛЬНО в index.js (там же, где стоп-слова) —
// потому что и там, и там нужно одно и то же side-effect действие (выключить
// aiActive + уведомить менеджера), а не текстовый ответ модели. Поэтому его
// обработчик здесь просто возвращает служебный маркер, а не лезет в Mongo/Bitrix сам.
async function toolEscalateToHuman({ reason }) {
  return `[[ESCALATED:${reason || 'клиент просит человека'}]]`;
}

const TOOL_HANDLERS = {
  check_product_catalog: toolCheckProductCatalog,
  check_my_deal_status: toolCheckMyDealStatus,
  escalate_to_human: toolEscalateToHuman,
};

// ---------- Хранение истории диалога ----------

export async function loadHistory(db, chatId) {
  if (!db) return [];
  const doc = await db.collection('aiConversations').findOne({ chatId });
  return doc?.messages || [];
}

async function saveHistory(db, chatId, messages) {
  if (!db) return;
  // храним только последние N сообщений — это ограничивает и токены, и размер документа
  const trimmed = messages.slice(-AI_MAX_HISTORY_MESSAGES);
  await db.collection('aiConversations').updateOne(
    { chatId },
    { $set: { chatId, messages: trimmed, updatedAt: new Date() } },
    { upsert: true },
  );
}

// ---------- Вызов модели ----------

async function callModel(messages) {
  try {
    const { data } = await axios.post(
      `${AI_BASE_URL}/chat/completions`,
      { model: AI_MODEL, messages, tools: AI_TOOLS, tool_choice: 'auto' },
      { headers: { Authorization: `Bearer ${AI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 },
    );
    return data.choices[0].message;
  } catch (err) {
    // ФИКС "Request failed with status code 404/401/..." без деталей: axios бросает
    // исключение ДО того, как мы можем прочитать тело ответа (обычно там и лежит
    // настоящая причина — "model not found", "invalid api key" и т.п.). Достаём его
    // и кладём в сообщение, как уже сделано для bitrixCall в bitrix.js.
    if (err.response) {
      const body = err.response.data;
      const detail = body?.error?.message || body?.error_description || JSON.stringify(body);
      throw new Error(`AI API (${AI_BASE_URL}, model=${AI_MODEL}): HTTP ${err.response.status} — ${detail}`);
    }
    throw err;
  }
}

const SYSTEM_PROMPT = `Ты — вежливый консультант компании в Telegram-чате. Отвечай кратко, по-русски, дружелюбно.
Ты умеешь:
— отвечать на вопросы о товарах/услугах и ценах (используй check_product_catalog);
— проверять статус заявки/встречи текущего клиента (используй check_my_deal_status, chatId клиента передавать не нужно — это делается автоматически);
— передавать диалог человеку (используй escalate_to_human), если клиент просит оператора/менеджера/человека, либо если вопрос вне твоей компетенции (жалобы, нестандартные просьбы, ты не уверен в ответе).
Не выдумывай цены и наличие — только по данным из check_product_catalog. Если инструмент не нашёл товар — так и скажи, не придумывай.`;

// ---------- Публичная функция: обработать сообщение пользователя ----------
//
// Возвращает { replyText, escalate, escalateReason }.
// replyText — что отправить клиенту (может быть null, если только эскалация).
// escalate — true, если нужно выключить aiActive и позвать менеджера.
export async function handleUserMessage({ db, chatId, userText, username }) {
  const history = await loadHistory(db, chatId);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userText },
  ];

  let escalate = false;
  let escalateReason = null;

  // Цикл на случай нескольких последовательных вызовов инструментов подряд
  // (модель вызвала функцию -> получила результат -> решила вызвать ещё одну).
  for (let step = 0; step < 4; step++) {
    const assistantMsg = await callModel(messages);
    messages.push(assistantMsg);

    const toolCalls = assistantMsg.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      // Обычный текстовый ответ — финал.
      await saveHistory(db, chatId, [...history, { role: 'user', content: userText }, assistantMsg]);
      return { replyText: assistantMsg.content || null, escalate, escalateReason };
    }

    for (const call of toolCalls) {
      const fn = TOOL_HANDLERS[call.function.name];
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* оставляем {} */ }

      let resultText;
      if (!fn) {
        resultText = `Неизвестный инструмент: ${call.function.name}`;
      } else {
        resultText = await fn({ ...args, chatId, db, username });
      }

      const escMatch = /^\[\[ESCALATED:(.*)\]\]$/.exec(resultText);
      if (escMatch) {
        escalate = true;
        escalateReason = escMatch[1];
      }

      messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
    }
  }

  // Не уложились в лимит шагов — на всякий случай отдаём то, что накопилось, как эскалацию
  return { replyText: 'Секунду, уточню у менеджера и вернусь с ответом.', escalate: true, escalateReason: escalateReason || 'много шагов ИИ без финального ответа' };
}

// ---------- Стоп-слова (быстрый путь, без обращения к модели) ----------

const STOP_WORDS_RE = /(позови|позовите|соедини|дай)?\s*(человека|оператора|менеджера)|живой\s*человек|хочу\s*человека/i;

export function isStopWordTrigger(text) {
  return STOP_WORDS_RE.test(String(text || ''));
}
