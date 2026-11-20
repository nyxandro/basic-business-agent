// What the agent is told about widgets in the chat (spec, section 8.31): with «Виджеты в чате» on — when to draw, how
// (ui_components, then render_ui), the three rules of the look of the mockup, and one line per component; off — that
// they are switched off. The block changes only with the switch, so the system prompt stays the same from turn to turn.
import { WIDGET_TOOL } from '@bba/contracts';
import { componentIndex } from './catalog.ts';

const { components: COMPONENTS, render: RENDER } = WIDGET_TOOL;

export function widgetsRules(): string {
  return [
    '## Виджеты в чате',
    '- Когда ответ лучше показать, чем пересказать, собери виджет — экран из компонентов ниже: сравнение вариантов, расчёт с параметрами, которые сотрудник подвигает сам, сводка с цифрами и графиком, форма для данных, выбор из вариантов. Короткий факт, разговор, простой список — текстом, без виджета.',
    `- Сначала \`${COMPONENTS}\` с именами всех компонентов будущего экрана, потом \`${RENDER}\` по полученному описанию. Один вызов \`${RENDER}\` — один экран. Текст ответа — до или после экрана, не повторяй в нём то, что видно на экране.`,
    `- Если \`${RENDER}\` вернул ошибку — исправь и вызови заново целиком; после двух неудач ответь текстом. Чтобы поправить экран, уже показанный в этом ответе, не рисуй второй: вызови \`${RENDER}\` с updateComponents или updateDataModel для его surfaceId — он изменится на месте. Экран прошлого ответа так не меняется: нарисуй новый.`,
    '- Вид: главный итог или рекомендованный вариант — Card с background "discovery-solid" (стеклянная панель) или EntityCard с плашкой цвета "discovery"; такой акцент один на экран. Цвета success, warning, danger, info — только для статусов. Рамка (Card) — у формы, калькулятора и выбора; таблицу и график в Card не клади.',
    '- Все тексты на экране — по-русски. Деньги — formatCurrency с currency "RUB" и decimals: 0; в ${…} — только функции из описания, по именам. Кнопка без ссылки отправляет от имени сотрудника сообщение с её подписью и значениями полей; действие во внешней системе после него — как обычно, через подтверждение.',
    '- Больше 20 строк данных в экран не перепечатывай: покажи главное, а полную таблицу — инструментом, который её возвращает, или файлом.',
    '',
    'Компоненты:',
    componentIndex(),
  ].join('\n');
}

export const WIDGETS_OFF = 'Виджетов в чате у тебя нет — они выключены в настройках агента. Отвечай текстом; таблицы — в Markdown.';
