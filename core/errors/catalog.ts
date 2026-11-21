// Error codes with their HTTP status and the text for people (spec, section 9).
// The texts already say what to do next, so `nextStep` is set only where it adds something.
import { AppError } from './app-error.ts';

interface CatalogEntry {
  status: number;
  userMessage: string;
  nextStep?: string;
}

export const ERROR_CATALOG = {
  APP_VALIDATION_FAILED: { status: 400, userMessage: 'Данные заполнены неверно. Проверьте поля и попробуйте ещё раз.' },
  APP_NOT_FOUND: { status: 404, userMessage: 'Такой страницы или данных нет.' },
  APP_INTERNAL: { status: 500, userMessage: 'Что-то пошло не так на сервере. Попробуйте ещё раз; если повторяется — сообщите администратору код ошибки.' },
  APP_AUTH_INVALID_CREDENTIALS: { status: 401, userMessage: 'Неверная почта или пароль. Проверьте раскладку и попробуйте ещё раз.' },
  APP_AUTH_RATE_LIMITED: { status: 429, userMessage: 'Слишком много попыток входа. Подождите несколько минут и попробуйте снова.' },
  APP_AUTH_BANNED: { status: 403, userMessage: 'Ваша учётная запись заблокирована. Обратитесь к администратору.' },
  APP_AUTH_SESSION_EXPIRED: { status: 401, userMessage: 'Сессия истекла. Войдите заново — разговоры сохранены.' },
  APP_PASSWORD_TOO_SHORT: { status: 400, userMessage: 'Пароль слишком короткий: нужно не меньше 10 символов.' },
  APP_INVITE_INVALID: { status: 410, userMessage: 'Ссылка-приглашение недействительна или уже использована. Попросите администратора прислать новую.' },
  APP_INVITE_EMAIL_EXISTS: {
    status: 409,
    userMessage: 'Сотрудник с этой почтой уже есть. Если он заблокирован — разблокируйте его, если забыл пароль — создайте ссылку для сброса.',
  },
  APP_PASSWORD_RESET_INVALID: { status: 410, userMessage: 'Ссылка для смены пароля недействительна или устарела. Попросите администратора создать новую.' },
  APP_ADMIN_FORBIDDEN: { status: 403, userMessage: 'Этот раздел вам недоступен. Если он нужен для работы, обратитесь к администратору.' },
  APP_ADMIN_SAVE_FAILED: { status: 500, userMessage: 'Не удалось сохранить изменения. Попробуйте ещё раз; если повторяется — сообщите код ошибки.' },
  APP_ADMIN_LAST_SUPERADMIN: {
    status: 409,
    userMessage: 'Нельзя снять эту роль с последнего суперадминистратора — иначе управлять системой станет некому.',
  },
  APP_ADMIN_BUILTIN_ROLE: { status: 409, userMessage: 'Встроенную роль нельзя удалить или переименовать, а права суперадминистратора — сузить.' },
  APP_ADMIN_NAME_TAKEN: { status: 409, userMessage: 'Такое название уже занято. Выберите другое.' },
  APP_PROJECT_EXISTS: { status: 409, userMessage: 'Проект с таким названием уже есть.' },
  APP_SEARCH_FAILED: { status: 500, userMessage: 'Поиск сейчас не работает. Попробуйте ещё раз.' },
  APP_PROJECT_SAVE_FAILED: { status: 500, userMessage: 'Не удалось сохранить проект. Попробуйте ещё раз.' },
  APP_PROJECT_OWNER_ONLY: { status: 403, userMessage: 'Это может только создатель проекта.' },
  APP_PROJECT_ARCHIVED: { status: 409, userMessage: 'Проект в архиве. Верните его, чтобы что-то изменить.' },
  APP_PROJECT_ACCESS_LOST: { status: 404, userMessage: 'Файл лежит в проекте, к которому у вас больше нет доступа.' },
  APP_FILE_IN_TRASH: { status: 404, userMessage: 'Файл удалён из рабочей папки и лежит в корзине проекта.' },
  APP_FILE_DELETED: { status: 404, userMessage: 'Файл удалён из рабочей папки — скачать его нельзя.' },
  APP_PROJECT_DELETE_TOO_EARLY: { status: 409, userMessage: 'Удалить проект навсегда можно только через 30 дней после переноса в архив.' },
  APP_ADMIN_DELETE_PARTIAL: {
    status: 500,
    userMessage: 'Удалено не всё. Нажмите «Удалить» ещё раз — повтор безопасен. Пока удаление не завершено, сотрудник заблокирован.',
  },
  APP_MODEL_GATEWAY_UNAVAILABLE: { status: 503, userMessage: 'Сервис моделей сейчас не отвечает. Попробуйте через минуту; если повторяется — сообщите администратору код ошибки.' },
  APP_MODEL_UNAVAILABLE: { status: 503, userMessage: 'Модель сейчас не отвечает. Попробуйте ещё раз через минуту; если повторяется — сообщите администратору код ошибки.' },
  APP_MODEL_TIMEOUT: { status: 504, userMessage: 'Модель слишком долго не отвечала, и ответ остановлен. Попробуйте ещё раз; если повторяется — сообщите администратору код ошибки.' },
  APP_CHAT_NOT_INTERRUPTED: { status: 409, userMessage: 'Последний ответ не оборван — отвечать заново нечего. Обновите страницу.' },
  APP_CHAT_ANSWER_AGAIN_USELESS: { status: 409, userMessage: 'Ответить заново здесь не поможет: ответ прервался не из-за сбоя. Сделайте то, что сказано в сообщении об ошибке.' },
  APP_CHAT_ACTION_DONE: { status: 409, userMessage: 'В этом ответе агент уже выполнил действие, поэтому заново его не повторить — иначе действие выполнится дважды. Напишите агенту, что делать дальше.' },
  APP_MODEL_RATE_LIMITED: { status: 429, userMessage: 'Слишком много запросов к модели. Подождите минуту и отправьте сообщение снова.' },
  APP_MODEL_AUTH_FAILED: { status: 502, userMessage: 'Не удалось обратиться к модели: проблема с настройками доступа. Сообщите администратору код ошибки.' },
  APP_MODEL_CONTEXT_EXCEEDED: { status: 400, userMessage: 'Разговор стал слишком длинным для модели. Начните новый — агент помнит важное о вас.' },
  APP_MODEL_NOT_CONFIGURED: { status: 503, userMessage: 'Модели ещё не настроены. Обратитесь к администратору.' },
  APP_MODEL_CHECK_FAILED: { status: 400, userMessage: 'Провайдер не принял ключ. Проверьте ключ и модель провайдера.' },
  APP_MODEL_IN_USE: { status: 409, userMessage: 'Модель нужна агентам. Сначала выберите основную модель организации или другую модель этим агентам.' },
  APP_MODEL_OUTPUT_LIMIT_REQUIRED: {
    status: 400,
    userMessage: 'Шлюз не знает, какой длины ответ даёт эта модель. Укажите наибольшую длину ответа в токенах — она есть в описании модели у провайдера (у Groq — «Max completion tokens»).',
  },
  APP_MODEL_OUTPUT_LIMIT_REJECTED: {
    status: 400,
    userMessage: 'Провайдер не принял наибольшую длину ответа этой модели. Укажите меньшую — она есть в описании модели у провайдера (у Groq — «Max completion tokens»).',
  },
  APP_VOICE_NOT_CONFIGURED: { status: 409, userMessage: 'Голосовой ввод в этой установке не настроен.' },
  APP_VOICE_FAILED: { status: 502, userMessage: 'Не удалось распознать запись. Попробуйте ещё раз или напишите текстом.' },
  APP_SKILL_INVALID: { status: 400, userMessage: 'Файл скилла не подходит.' },
  APP_AGENT_IMAGE_INVALID: { status: 400, userMessage: 'Картинка не подходит: нужен PNG, JPEG или WebP.' },
  APP_SKILL_EXISTS: { status: 409, userMessage: 'Скилл с таким именем уже загружен. Чтобы обновить его, нажмите «Заменить».' },
  APP_SKILL_SYSTEM: { status: 409, userMessage: 'Это системный скилл: он встроен в ядро и всегда включён у всех сотрудников. Выключить, заменить или удалить его нельзя.' },
  APP_CHATGPT_LOGIN_EXPIRED: { status: 410, userMessage: 'Время на вход вышло. Начните заново.' },
  APP_CHATGPT_LOGIN_FAILED: { status: 502, userMessage: 'Вход не выполнен. Попробуйте ещё раз.' },
  APP_GATEWAY_SYNC_FAILED: { status: 502, userMessage: 'Шлюз не принял изменения. Попробуйте ещё раз; если повторяется — сообщите разработчику код.' },
  APP_USAGE_LIMIT_EXCEEDED: {
    status: 402,
    userMessage: 'Ваш лимит расходов на этот месяц исчерпан. Новый лимит начнётся {date}. Если нужно раньше — обратитесь к администратору.',
  },
  APP_USAGE_ORG_LIMIT_EXCEEDED: { status: 402, userMessage: 'Лимит расходов организации на этот месяц исчерпан. Новый лимит начнётся {date}. Обратитесь к администратору.' },
  APP_USAGE_DAILY_CAP_EXCEEDED: {
    status: 402,
    userMessage: 'На сегодня ваш лимит запросов к модели исчерпан. Он обновится завтра; если нужно раньше — обратитесь к администратору.',
  },
  APP_MASKING_FAILED: {
    status: 500,
    userMessage: 'Не удалось подготовить запрос к модели: не сработала защита персональных данных. Попробуйте ещё раз; если повторяется — сообщите администратору код ошибки.',
  },
  APP_SANDBOX_UNAVAILABLE: {
    status: 503,
    userMessage: 'Не удалось запустить рабочую среду агента. Попробуйте ещё раз через минуту; если повторяется — сообщите администратору код ошибки.',
  },
  APP_SANDBOX_BUSY: { status: 503, userMessage: 'Рабочая среда сейчас занята другими задачами. Попробуйте через минуту.' },
  // Viewing documents (spec, section 8.27).
  APP_PREVIEW_UNSUPPORTED: { status: 415, userMessage: 'Этот файл нельзя посмотреть здесь — скачайте его.' },
  APP_PREVIEW_TOO_BIG: { status: 413, userMessage: 'Файл больше 50 МБ — посмотреть его здесь нельзя. Скачайте его.' },
  APP_PREVIEW_PASSWORD: { status: 422, userMessage: 'Документ защищён паролем — посмотреть его здесь нельзя. Скачайте его.' },
  APP_PREVIEW_FAILED: {
    status: 422,
    userMessage: 'Не получилось показать документ: файл повреждён, защищён паролем или в формате, который сервер не понимает. Скачайте его и откройте у себя.',
  },
  APP_PREVIEW_TIMEOUT: { status: 504, userMessage: 'Документ слишком долго готовится к просмотру. Скачайте его или попробуйте позже.' },
  APP_PREVIEW_BUSY: { status: 503, userMessage: 'Сейчас готовится много документов. Попробуйте через минуту.' },
  APP_UPLOAD_TOO_LARGE: { status: 413, userMessage: 'Файл больше 20 МБ. Сожмите его или разделите на части.' },
  APP_UPLOAD_TYPE_UNSUPPORTED: {
    status: 415,
    userMessage: 'Такой формат агент пока не читает. Подойдут документы, таблицы и презентации (Word, Excel, PowerPoint, PDF, OpenDocument, RTF), текст и разметка (TXT, Markdown, CSV, JSON, XML, HTML, YAML), письма EML, архивы ZIP и картинки (PNG, JPG, WebP, GIF, TIFF, BMP).',
  },
  APP_MARKS_PICTURE_INVALID: { status: 400, userMessage: 'Сервер не принял картинку с пометками. Попробуйте отправить ещё раз; если повторяется — сообщите администратору код ошибки.' },
  APP_BACKGROUND_RUN_SKIPPED: { status: 409, userMessage: 'Запуск задачи пропущен: предыдущий запуск ещё ждёт вашего решения.' },
  APP_BACKGROUND_RUN_FAILED: { status: 500, userMessage: 'Задача не выполнилась. Можно запустить её снова.' },
  APP_APPROVAL_EXPIRED: { status: 410, userMessage: 'Истекло: действие не выполнено. Если оно ещё нужно, запустите задачу снова.' },
  APP_APPROVAL_DECIDED: { status: 409, userMessage: 'По этому действию решение уже принято.' },
  APP_MEMORY_FULL: { status: 409, userMessage: 'Память заполнена. Удалите устаревшие записи и попробуйте снова.' },
  APP_MEMORY_ENTRY_TOO_LONG: { status: 400, userMessage: 'Запись — не длиннее 400 знаков.' },
  APP_MEMORY_ENTRY_NOT_FOUND: { status: 404, userMessage: 'Этой записи уже нет: её удалили.' },
  APP_MEMORY_DUPLICATE: { status: 409, userMessage: 'Такая запись уже есть.' },
  APP_MEMORY_CONFLICT: { status: 409, userMessage: 'Запись изменили, пока вы её правили.' },
  APP_MEMORY_SAVE_FAILED: { status: 500, userMessage: 'Не удалось сохранить запись. Попробуйте ещё раз.' },
  APP_CONVERSATIONS_UNAVAILABLE: { status: 500, userMessage: 'Не получилось посмотреть прошлые разговоры: сбой на сервере.' },
  // The internet of agents (spec, section 8.30): the model gets its own text of each, people see these.
  APP_WEB_PERSONAL_DATA: { status: 400, userMessage: 'Паспорт, СНИЛС и номер карты в интернет не отправляются — так настроено в организации.' },
  APP_WEB_RESEARCH_FAILED: { status: 502, userMessage: 'Поиск в интернете не получился. Попробуйте ещё раз позже.' },
  APP_WEB_SEARCH_FAILED: { status: 502, userMessage: 'Поиск в интернете сейчас не отвечает. Попробуйте ещё раз позже.' },
  APP_WEB_FETCH_BAD_URL: { status: 400, userMessage: 'Это не адрес страницы: нужен адрес, который начинается с http:// или https://.' },
  APP_WEB_FETCH_BLOCKED_ADDRESS: { status: 400, userMessage: 'Это внутренний адрес: такие страницы не открываются.' },
  APP_WEB_FETCH_BLOCKED_BY_SITE: { status: 502, userMessage: 'Сайт не пустил: он требует входа или закрыт от программ.' },
  APP_WEB_FETCH_HTTP: { status: 502, userMessage: 'Сайт ответил ошибкой — страница не открылась.' },
  APP_WEB_FETCH_TIMEOUT: { status: 504, userMessage: 'Сайт не ответил за 20 секунд.' },
  APP_WEB_FETCH_TOO_LARGE: { status: 413, userMessage: 'Файл по ссылке больше 10 МБ — такой не скачивается.' },
  APP_WEB_FETCH_UNSUPPORTED: { status: 415, userMessage: 'По ссылке не страница и не документ — прочитать его нельзя.' },
  APP_WEB_FETCH_BUSY: { status: 503, userMessage: 'Сервер сейчас занят разбором документов — попробуйте чуть позже.' },
  APP_WEB_FETCH_NO_TEXT: { status: 422, userMessage: 'На странице нет текста — прочитать её не получилось.' },
  // MCP servers the admin adds (docs/specs/[20.11.2026]-mcp-connections.md, section 9).
  APP_MCP_UNREACHABLE: { status: 502, userMessage: 'Сервер не отвечает по этому адресу. Проверьте адрес и что сервер включён.' },
  APP_MCP_NOT_MCP: { status: 422, userMessage: 'По этому адресу нет сервера MCP. В инструкции системы адрес обычно заканчивается на /mcp.' },
  APP_MCP_OAUTH_REGISTRATION: {
    status: 422,
    userMessage: 'Система не разрешает подключать сторонние программы автоматически. Заведите приложение в настройках системы и введите Client ID и Client Secret в «Дополнительно».',
  },
  APP_MCP_PACKAGE_FAILED: { status: 422, userMessage: 'Не удалось скачать пакет программы. Проверьте название и версию.' },
  APP_MCP_PROGRAM_CRASHED: {
    status: 503,
    userMessage: 'Программа-сервер падает — агенты не могут ею пользоваться. Проверьте настройки или версию пакета и нажмите «Проверить своим доступом».',
  },
  APP_MCP_RUNNER_NOT_CONFIGURED: {
    status: 409,
    userMessage: 'Программы-серверы в этой установке не включены: нет контейнера mcp-runner. Подключите систему по адресу или попросите того, кто ставил установку, включить его.',
  },
  APP_MCP_OAUTH_NEEDS_HTTPS: { status: 409, userMessage: 'Вход через сайт системы работает только когда установка открыта по https.' },
  // The letterhead, the stamp and the signature (docs/specs/[20.11.2026]-org-letterhead.md).
  APP_ORG_BLANK_FORMAT: { status: 400, userMessage: 'Нужен бланк в формате Word (.docx). Откройте файл в Word и сохраните как .docx.' },
  APP_ORG_BLANK_BROKEN: { status: 422, userMessage: 'Бланк не открывается: он защищён паролем или повреждён. Выберите другой файл.' },
  APP_ORG_IMAGE_FORMAT: { status: 400, userMessage: 'Нужна картинка PNG или JPEG. Выберите другую.' },
  APP_SIGN_FORBIDDEN_KIND: {
    status: 422,
    userMessage: 'На счёте-фактуре, УПД и доверенности факсимиле подписи не допускается — подпишите документ от руки или электронной подписью.',
  },
  APP_SIGN_NOT_ALLOWED: { status: 403, userMessage: 'Печать и подпись руководителя ставят только ответственные лица. Документ готов со строкой для подписи.' },
  APP_SIGN_NOT_UPLOADED: { status: 409, userMessage: 'Печать организации не загружена. Суперадминистратор может добавить её в «Профиле организации».' },
  APP_SIGN_NO_MARKS: { status: 422, userMessage: 'В документе нет места для подписи: метки [[ПОДПИСЬ_РУКОВОДИТЕЛЯ]].' },
  APP_SIGN_FORMAT: { status: 422, userMessage: 'Печать и подпись ставятся только в документ Word (.docx).' },
  APP_SIGN_TOO_BIG: { status: 413, userMessage: 'Документ слишком большой для печати и подписи. Сделайте его заново, без лишних картинок.' },
  APP_SIGN_CHANGED: {
    status: 409,
    userMessage: 'Документ изменился после вопроса «Да» — печать и подпись не поставлены. Попросите агента поставить их заново: вы подтвердите новый вариант.',
  },
  APP_SIGN_FAILED: { status: 500, userMessage: 'Не получилось поставить печать и подпись. Попробуйте ещё раз; если повторяется — сообщите код ошибки администратору.' },
  // Notifications in the browser (docs/specs/[20.11.2026]-notifications.md).
  APP_NOTIFICATION_FAILED: { status: 500, userMessage: 'Не удалось записать уведомление. Само действие выполнено.' },
  APP_PUSH_SUBSCRIBE_FAILED: { status: 400, userMessage: 'Не удалось включить уведомления. Попробуйте ещё раз.' },
  APP_PUSH_NOT_SUBSCRIBED: { status: 409, userMessage: 'Уведомления в этом браузере не включены. Включите их и попробуйте снова.' },
  APP_PUSH_FAILED: { status: 502, userMessage: 'Сервис уведомлений браузера не принял уведомление. Список уведомлений в приложении работает.' },
} satisfies Record<`APP_${string}`, CatalogEntry>;

export type CatalogCode = keyof typeof ERROR_CATALOG;

export function appError(
  code: CatalogCode,
  message: string,
  extra: { cause?: unknown; details?: Record<string, unknown>; userMessage?: string } = {},
): AppError {
  const entry: CatalogEntry = ERROR_CATALOG[code];
  return new AppError({
    code,
    message,
    userMessage: extra.userMessage ?? entry.userMessage,
    status: entry.status,
    ...(entry.nextStep ? { nextStep: entry.nextStep } : {}),
    ...(extra.cause !== undefined ? { cause: extra.cause } : {}),
    ...(extra.details ? { details: extra.details } : {}),
  });
}
