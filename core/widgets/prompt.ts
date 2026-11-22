// What the agent is told about widgets in the chat (spec, section 8.31): with «Виджеты в чате» on — when to draw (data
// and entities on its own initiative, owner 22.11), how
// (ui_components, then render_ui), the three rules of the look of the mockup, and one line per component; off — that
// they are switched off. The block changes only with the switch, so the system prompt stays the same from turn to turn.
import { WIDGET_TOOL } from '@bba/contracts';
import { abilitiesOf } from '../abilities/abilities.ts';
import { componentIndex } from './catalog.ts';

const { components: COMPONENTS, render: RENDER } = WIDGET_TOOL;

export function widgetsRules(): string {
  return [
    '## Виджеты в чате',
    // Owner, 22.11: entities and data are shown as widgets on the agent's own initiative, not as a wall of text.
    '- Данные и сущности показывай виджетом, а не простынёй текста — сам, без просьбы сотрудника, когда так понятнее:',
    '  - несколько однотипных сущностей из подключённых систем, почты, памяти или поиска — сделки, клиенты, письма, задачи, документы, позиции КП — карточками (EntityCard или List с ListItem: главное в заголовке, статус — Badge) или таблицей из главных полей;',
    '  - сводка или отчёт — итоговые цифры наверху и график по динамике или долям; несколько показателей сразу — панелью: Grid с цифрами и графиками;',
    '  - сравнение вариантов, тарифов, предложений — рядом, карточками или таблицей, рекомендованный выделен;',
    '  - расчёт, где сотрудник захочет подвигать параметры, — калькулятор со Slider и полями ввода;',
    '  - нужны данные или выбор от сотрудника — форма или выбор вариантов.',
    '- Три и больше однотипных записей — из инструмента (почта, системы, поиск, память) или из сообщения сотрудника — всегда виджетом, даже если хочется пересказать их по категориям: сгруппируй на экране (вкладки, разделы, Badge статуса), а текстом — вывод в одну-две фразы.',
    '- Текстом, без виджета: короткий ответ, разговор, объяснение, совет, одна сущность в паре фраз, один-два пункта своими словами. Попросили ответить текстом — отвечай текстом.',
    `- Сначала \`${COMPONENTS}\` с именами всех компонентов будущего экрана, потом \`${RENDER}\` по полученному описанию. Один вызов \`${RENDER}\` — один экран целиком, все компоненты сразу, не частями; operations — массив объектов, не строка. Текст ответа — до или после экрана, не повторяй в нём то, что видно на экране.`,
    `- Если \`${RENDER}\` вернул ошибку — исправь и вызови заново целиком; после двух неудач ответь текстом. Чтобы поправить экран, уже показанный в этом ответе, не рисуй второй: вызови \`${RENDER}\` с updateComponents или updateDataModel для его surfaceId — он изменится на месте. Экран прошлого ответа так не меняется: нарисуй новый.`,
    '- Вид: главный итог или рекомендованный вариант — Card с background "discovery-solid" (стеклянная панель) или EntityCard с плашкой цвета "discovery"; такой акцент один на экран. Цвета success, warning, danger, info — только для статусов. Рамка (Card) — у формы, калькулятора и выбора; таблицу и график в Card не клади. У графика — title с единицами, например «Выручка, млн ₽». Отступы (gap, padding) — числом шагов по 4 px.',
    '- Все тексты на экране — по-русски. Деньги — formatCurrency с currency "RUB" и decimals: 0; в ${…} — только функции из описания, по именам. Кнопка с событием (onClick с event) отправляет от имени сотрудника сообщение: userMessage, а без него — подпись кнопки, и строки значений из context; userMessage пиши той же подписью, что на кнопке, — сотрудник отправляет то, что видит. Кнопка без события и без ссылки ничего не делает. Действие во внешней системе после нажатия — как обычно, через подтверждение.',
    '- Больше 20 строк данных в экран не перепечатывай: покажи главное, а полную таблицу — инструментом, который её возвращает, или файлом.',
    '',
    'Компоненты:',
    componentIndex(),
  ].join('\n');
}

export const WIDGETS_OFF = 'Виджетов в чате у тебя нет — они выключены в настройках агента. Отвечай текстом; таблицы — в Markdown.';

// The constant line of a tool's result with a list (issue #32; the one field of a result the agent follows, as the note of
// memory, section 8.26): with widgets on, three and more records go to the person as a widget. The rule in the system
// prompt alone did not do it — after `mailbox_list` with 20 letters the live model wrote a summary by categories.
export const LIST_NOTE = `Записей три и больше, а виджеты у тебя включены: покажи их сотруднику виджетом — карточками или таблицей (${COMPONENTS}, затем ${RENDER}), сгруппируй на экране, а текстом напиши вывод в одну-две фразы. Если сотрудник просил ответить текстом — текстом.`;
export const LIST_NOTE_FROM = 3;

type ToolCtx = { requestContext?: { get(key: string): unknown } } | undefined;

export function listNote(ctx: ToolCtx, records: number): { note?: string } {
  return records >= LIST_NOTE_FROM && abilitiesOf(ctx?.requestContext).widgets ? { note: LIST_NOTE } : {};
}
