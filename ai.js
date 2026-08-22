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
import { bitrixCall, getDeal, addDealComment, createInterestDeal, createOrderDeal, getProductPhotoUrl, ORG_TIMEZONE } from './bitrix.js';
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
      name: 'send_product_photo',
      description:
        'Отправить клиенту в Telegram настоящее фото товара из каталога Битрикс24. Вызывай, когда клиент просит показать/прислать фото, картинку, "как выглядит" какого-то товара. Это НЕ ответ текстом — фото уйдёт отдельным сообщением автоматически, тебе не нужно ничего вставлять в текст самому.',
      parameters: {
        type: 'object',
        properties: {
          product_name: { type: 'string', description: 'Название МОДЕЛИ товара, чьё фото нужно отправить (например "Nike Air Force 1") — размер и цвет указывать не обязательно, фото одно на модель' },
        },
        required: ['product_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_order',
      description:
        'Оформить реальный заказ клиента в CRM. Вызывай ЭТОТ инструмент ТОЛЬКО когда у тебя есть ВСЕ пять полей, явно подтверждённые клиентом в переписке: точное название товара (сверенное через check_product_catalog), размер, цвет, адрес доставки и способ оплаты. Если чего-то из этого не хватает — НЕ вызывай инструмент, а сначала спроси клиента текстом (по одному недостающему пункту за раз). До успешного вызова этого инструмента НИКОГДА не говори клиенту фразы вроде "заказ оформлен"/"уже оформляю"/"ваш заказ принят" — это будет неправдой, потому что реального заказа в системе ещё нет.',
      parameters: {
        type: 'object',
        properties: {
          product_name: { type: 'string', description: 'Точное название товара из каталога (как вернул check_product_catalog)' },
          size: { type: 'string', description: 'Размер, подтверждённый клиентом' },
          color: { type: 'string', description: 'Цвет, подтверждённый клиентом' },
          delivery_address: { type: 'string', description: 'Адрес доставки, продиктованный клиентом' },
          payment_method: {
            type: 'string',
            enum: ['online', 'cash_on_delivery'],
            description: "Строго одно из двух: 'online' — клиент оплатит онлайн заранее (картой/переводом); 'cash_on_delivery' — оплата курьеру при получении. Уточни у клиента именно этот выбор словами, а не произвольный текст — от этого зависит, в какую стадию воронки попадёт сделка.",
          },
        },
        required: ['product_name', 'size', 'color', 'delivery_address', 'payment_method'],
      },
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

// Запоминаем последний товар, который реально нашёлся в каталоге для этого чата —
// нужно для детерминированной отправки фото (см. tryPhotoShortcut ниже), чтобы не
// зависеть от того, вызовет ли модель send_product_photo сама.
async function rememberLastProduct(db, chatId, productName) {
  if (!db || !productName) return;
  await db.collection('aiConversations').updateOne(
    { chatId },
    { $set: { lastProductName: productName } },
    { upsert: true },
  );
}

async function getLastProductName(db, chatId) {
  if (!db) return null;
  const doc = await db.collection('aiConversations').findOne({ chatId });
  return doc?.lastProductName || null;
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
    await rememberLastProduct(db, chatId, list[0].name);
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

// ФИКС "на просьбу прислать фото бот зовёт менеджера": раньше у ИИ вообще не было
// инструмента для этого, и просьба "покажи фото" попадала под общее описание
// escalate_to_human ("вопрос вне твоей компетенции"). Сам факт отправки файла в
// Telegram делает index.js (там же лежит BOT_TOKEN/API, а сюда его тащить не стоит,
// чтобы не плодить циклическую зависимость) — поэтому здесь так же, как и с
// escalate_to_human, возвращаем служебный маркер с URL фото, а handleUserMessage
// ниже вычленяет его из ответа инструмента и кладёт в photoUrl итогового результата.
// ФИКС "фото нет, хотя товар в каталоге есть": в этом каталоге размер/цвет — это
// ОТДЕЛЬНЫЕ карточки товара (например "Nike Air Force 1, 43, белые" и "Nike Air
// Force 1, 44, чёрные" — разные id), а не одна карточка с вариациями. Грузить
// фото в КАЖДУЮ такую карточку вручную неудобно и не нужно — это один и тот же
// товар. Поэтому вместо проверки только первой найденной карточки (list[0])
// перебираем ВСЕ карточки, подходящие под запрос, и берём фото у первой же, где
// оно реально загружено — не важно, что это могла быть карточка другого размера.
async function toolSendProductPhoto({ search_query, product_name, chatId, db, username }) {
  const query = product_name || search_query;
  try {
    const iblockId = await resolveCatalogIblockId();
    const products = await bitrixCall('catalog.product.list', {
      select: ['id', 'iblockId', 'name'],
      filter: { iblockId, '%name': query },
    });
    const list = products?.products || products || [];
    if (!list.length) return `Товар "${query}" не найден в каталоге, фото отправить нечего.`;

    for (const product of list.slice(0, 15)) {
      const photoUrl = await getProductPhotoUrl(product.id).catch(() => null);
      if (photoUrl) {
        return `[[SEND_PHOTO:${photoUrl}]] Фото товара "${product.name}" отправлено клиенту отдельным сообщением.`;
      }
    }
    return `Ни у одной карточки товара "${query}" в каталоге нет загруженного фото.`;
  } catch (err) {
    console.error('Инструмент send_product_photo упал:', err.message);
    return 'Не удалось получить фото товара из Битрикса (техническая ошибка).';
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

// ФИКС бага "бот говорит 'заказ оформлен', а сделки в Битриксе нет": раньше
// оформление заказа не было отдельным действием — модель просто дописывала в
// текстовый ответ выдуманное подтверждение (цвет/размер она тоже придумывала),
// ничего не создавая в CRM. Теперь единственный способ для клиента "получить"
// оформленный заказ — чтобы модель вызвала ЭТОТ инструмент, а он реально создаёт
// сделку в Битриксе (createOrderDeal в bitrix.js). Системный промпт (ниже) прямо
// запрещает модели произносить "заказ оформлен" до успешного вызова.
async function toolCreateOrder({ product_name, size, color, delivery_address, payment_method, chatId, db, username }) {
  try {
    const contactId = await ensureContact({ db, chatId, username }).catch(err => {
      console.error('Не удалось найти/создать карточку клиента для заказа:', err.message);
      return null;
    });
    const dealId = await createOrderDeal({
      chatId, username, contactId,
      productName: product_name, size, color,
      deliveryAddress: delivery_address, paymentMethod: payment_method,
    });
    return `Заказ успешно оформлен, сделка #${dealId} создана в CRM. Можешь подтвердить это клиенту.`;
  } catch (err) {
    console.error('Инструмент create_order упал:', err.message);
    return 'Не удалось оформить заказ (техническая ошибка при обращении к Битриксу). Скажи клиенту, что оформление задержалось, и предложи позвать менеджера (escalate_to_human).';
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
  send_product_photo: toolSendProductPhoto,
  create_order: toolCreateOrder,
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

// ФИКС "ИИ спрыгнул на простом вопросе (зовёт менеджера из-за технической заминки)":
// раньше ЛЮБОЙ сбой запроса к модели (таймаут, сеть моргнула, 429 — превышен лимит
// запросов у бесплатной/дешёвой модели, 5xx — сервер модели прилёг) сразу валил
// весь диалог в escalate_to_human, хотя чаще всего достаточно повторить запрос
// через секунду. Ретраим только ВРЕМЕННЫЕ причины (нет ответа вообще / 429 / 5xx),
// максимум 2 раза с небольшой паузой — а не сдаёмся сразу; настоящие ошибки
// (400 — сломанный запрос, 401 — неверный ключ и т.п.) как и раньше прокидываем
// наверх без пересылки, ретраить их бессмысленно.
async function callModel(messages, attempt = 1) {
  try {
    const { data } = await axios.post(
      `${AI_BASE_URL}/chat/completions`,
      { model: AI_MODEL, messages, tools: AI_TOOLS, tool_choice: 'auto' },
      { headers: { Authorization: `Bearer ${AI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 },
    );
    return data.choices[0].message;
  } catch (err) {
    const status = err.response?.status;
    const isTransient = !err.response || status === 429 || status >= 500;
    if (isTransient && attempt < 3) {
      console.warn(`⚠️  Сбой запроса к ИИ (попытка ${attempt}, status=${status ?? 'нет ответа'}), пробую ещё раз...`);
      await new Promise(resolve => setTimeout(resolve, 800 * attempt));
      return callModel(messages, attempt + 1);
    }
    // ФИКС "Request failed with status code 404/401/..." без деталей: axios бросает
    // исключение ДО того, как мы можем прочитать тело ответа (обычно там и лежит
    // настоящая причина — "model not found", "invalid api key" и т.п.). Достаём его
    // и кладём в сообщение, как уже сделано для bitrixCall в bitrix.js.
    if (err.response) {
      const body = err.response.data;
      const detail = body?.error?.message || body?.error_description || JSON.stringify(body);
      throw new Error(`AI API (${AI_BASE_URL}, model=${AI_MODEL}): HTTP ${status} — ${detail}`);
    }
    throw err;
  }
}

const SYSTEM_PROMPT = `Ты — вежливый консультант компании в Telegram-чате. Отвечай кратко, по-русски, дружелюбно.
Ты умеешь:
— отвечать на вопросы о товарах/услугах и ценах (используй check_product_catalog) — вызывай его при ЛЮБОМ упоминании товара клиентом, даже если он не спросил явно цену/наличие (например "мне нужны кроссовки" — это тоже повод вызвать check_product_catalog, а не отвечать по памяти). НИКОГДА не упоминай модель/товар, которого не было в результатах check_product_catalog В ЭТОМ диалоге — не предлагай клиенту "другие модели" или "модели с фото", которые ты не проверял через инструмент прямо сейчас;
— проверять статус заявки/встречи текущего клиента (используй check_my_deal_status, chatId клиента передавать не нужно — это делается автоматически);
— отправлять фото товара клиенту (используй send_product_photo), если он просит показать/прислать фото или картинку товара — это НЕ повод звать менеджера, ты можешь сделать это сам. НИКОГДА не утверждай, что у товара "нет фото в каталоге" или наоборот "фото есть", пока реально не вызвал send_product_photo и не увидел его результат — check_product_catalog информацию о фото не возвращает, поэтому раньше вызова send_product_photo ты об этом ничего не знаешь. Если не уверен, нужно ли фото клиенту — просто предложи прислать, а не делай заявлений о его наличии;
— оформлять заказ (используй create_order), но ТОЛЬКО после того, как по очереди уточнишь у клиента: 1) какой именно товар (сверь через check_product_catalog), 2) размер, 3) цвет, 4) адрес доставки, 5) способ оплаты — предложи клиенту выбрать РОВНО из двух вариантов: оплата онлайн заранее, или оплата курьеру при получении (это напрямую влияет на то, в какую стадию воронки попадёт сделка, поэтому не додумывай сам, если клиент ответил расплывчато — переспроси). Спрашивай недостающее по одному пункту за раз, не вываливай все вопросы сразу. Пока не собраны все пять пунктов — НЕ вызывай create_order и НЕ говори клиенту, что заказ оформлен, принят или уже готовится: это будет ложью, пока сделка реально не создана инструментом;
— передавать диалог человеку (используй escalate_to_human), если клиент просит оператора/менеджера/человека, либо если вопрос вне твоей компетенции (жалобы, нестандартные просьбы, ты не уверен в ответе).
Не выдумывай цены, наличие, цвета и размеры — только по данным из check_product_catalog и из того, что явно сказал клиент. Если инструмент не нашёл товар — так и скажи, не придумывай.`;

// ФИКС "модель не вызывает send_product_photo сама, а сочиняет ответ про фото
// (то 'нашёл', то 'не нашёл', иногда вообще про несуществующую модель)": для
// дешёвой/бесплатной модели это критичное действие нельзя доверять её "решению" —
// она ненадёжна. Поэтому запрос на фото детектируем СРАЗУ по ключевым словам (как
// уже сделано для стоп-слов эскалации) и вызываем send_product_photo НАПРЯМУЮ, в
// обход модели вообще — результат детерминирован независимо от того, насколько
// хорошо конкретная модель следует промпту.
const PHOTO_INTENT_RE = /фот|картин|покажи|как\s*выгляд|снимок/i;

async function tryPhotoShortcut({ db, chatId, userText, username }) {
  if (!PHOTO_INTENT_RE.test(userText)) return null;
  const productName = await getLastProductName(db, chatId);
  if (!productName) return null; // ещё не обсуждали никакой конкретный товар — пусть разбирается модель

  const resultText = await toolSendProductPhoto({ product_name: productName, chatId, db, username });
  const photoMatch = /\[\[SEND_PHOTO:(.*?)\]\]/.exec(resultText);
  const photoUrl = photoMatch ? photoMatch[1] : null;
  const replyText = photoUrl ? null : resultText; // если фото ушло — лишний текст не нужен

  // Сохраняем в историю, чтобы у модели дальше был контекст, что фото уже прислали
  // (или что его не нашлось) — иначе на следующий вопрос она снова будет гадать.
  const history = await loadHistory(db, chatId);
  await saveHistory(db, chatId, [
    ...history,
    { role: 'user', content: userText },
    { role: 'assistant', content: photoUrl ? `Отправил клиенту фото товара "${productName}".` : resultText },
  ]);

  return { replyText, escalate: false, escalateReason: null, photoUrl };
}

// ---------- Публичная функция: обработать сообщение пользователя ----------
//
// Возвращает { replyText, escalate, escalateReason }.
// replyText — что отправить клиенту (может быть null, если только эскалация).
// escalate — true, если нужно выключить aiActive и позвать менеджера.
export async function handleUserMessage({ db, chatId, userText, username }) {
  const photoShortcut = await tryPhotoShortcut({ db, chatId, userText, username });
  if (photoShortcut) return photoShortcut;

  const history = await loadHistory(db, chatId);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userText },
  ];

  let escalate = false;
  let escalateReason = null;
  let photoUrl = null;

  // Цикл на случай нескольких последовательных вызовов инструментов подряд
  // (модель вызвала функцию -> получила результат -> решила вызвать ещё одну).
  for (let step = 0; step < 4; step++) {
    const assistantMsg = await callModel(messages);
    messages.push(assistantMsg);

    const toolCalls = assistantMsg.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      // Обычный текстовый ответ — финал.
      await saveHistory(db, chatId, [...history, { role: 'user', content: userText }, assistantMsg]);
      return { replyText: assistantMsg.content || null, escalate, escalateReason, photoUrl };
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
      const photoMatch = /\[\[SEND_PHOTO:(.*?)\]\]/.exec(resultText);
      if (photoMatch) {
        photoUrl = photoMatch[1];
      }

      messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
    }
  }

  // Не уложились в лимит шагов — на всякий случай отдаём то, что накопилось, как эскалацию
  return { replyText: 'Секунду, уточню у менеджера и вернусь с ответом.', escalate: true, escalateReason: escalateReason || 'много шагов ИИ без финального ответа', photoUrl };
}

// ---------- Стоп-слова (быстрый путь, без обращения к модели) ----------

const STOP_WORDS_RE = /(позови|позовите|соедини|дай)?\s*(человека|оператора|менеджера)|живой\s*человек|хочу\s*человека/i;

export function isStopWordTrigger(text) {
  return STOP_WORDS_RE.test(String(text || ''));
}
