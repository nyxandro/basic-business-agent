# Примитивы A2UI: что даём агенту

**Статус:** зафиксирован владельцем 20.11.2026. Следующий шаг — оформление, затем перенос в спецификацию.

## Что это за список

Это все 69 компонентов стандартного набора CopilotKit (`@copilotkit/react-core` 2.0.0-rc.49, A2UI 1.0). Из них агент собирает экраны в чате. Названия даны как в библиотеке: модель пишет их именно так.

**Что значит «Да»:**
- одна строка в списке, который агент видит в каждом запросе (~15–20 токенов), и полное описание только тогда, когда агент собирается этим компонентом рисовать;
- компонент нужно оформить по макету в обеих темах и проверить на телефоне;
- у модели появляется ещё один способ ошибиться или выбрать не то.

**Что значит «Нет»:** компонента нет в каталоге. Агент о нём не знает, а браузер отклонит экран, в котором он встретится. Вернуть компонент потом можно без переделок.

**Как выставлены рекомендации:**
- нужно ли это в ответах бизнес-агента;
- не дублирует ли компонент другой;
- не грузит ли он файлы с чужих серверов — это запрещено решением владельца 19.11 (F36): картинки в ответах только с нашего сервера, и Caddy пропускает только их.

Итог после решений владельца 20.11: **43 — да, 26 — нет** (к рекомендациям агента добавлены Flow, FlowItem и Math).

**Как посмотреть вживую.** Название компонента в таблице — ссылка на его страницу в документации CopilotKit. Там живой пример (рисуется в браузере, модель не нужна), список полей и описание. Составные части — ячейка сетки, строка таблицы, пункт списка и подобные — показаны на странице своего «родителя». Вид там стандартный, у нас компоненты будут оформлены по макету. Все компоненты на одной странице: [стандартный каталог](https://docs.copilotkit.ai/generative-ui/components/standard-catalog).

## Раскладка

| №   | Компонент                                                                                                              | Что это                                                                                                        | Нужно? | Почему                                                                                          | Решение владельца |
| --- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------- | ----------------- |
| 1   | [Box](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/box)                                        | Универсальный контейнер: складывает содержимое в столбик или в ряд, может дать отступы, рамку, фон, скругление | Да     | Базовый кирпич: группа с рамкой или фоном                                                       |                   |
| 2   | [Column](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/column)                                  | Столбик: элементы друг под другом с ровными промежутками                                                       | Да     | Основа почти любого экрана                                                                      |                   |
| 3   | [Row](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/row)                                        | Ряд: элементы в строку («название — значение», кнопки внизу карточки)                                          | Да     | Основа почти любого экрана                                                                      |                   |
| 4   | [Grid](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/grid)                                      | Сетка из колонок; на узком экране сама складывается в одну колонку                                             | Да     | Тарифы рядом, показатели 2×2, карточки сделок                                                   |                   |
| 5   | [GridItem](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/grid#grid-item)                        | Ячейка сетки; может растянуться на несколько колонок                                                           | Да     | Идёт вместе с сеткой                                                                            |                   |
| 6   | [Card](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/card)                                      | Панель в рамке для интерактивного: калькулятор, форма, настройка. Для таблиц и графиков не нужна               | Да     | Рамка калькулятора и формы                                                                      |                   |
| 7   | [Flow](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/flow)                                      | «Кирпичная кладка»: плотно укладывает ячейки разного размера, как витрина                                      | Да | Плотная раскладка карточек разного размера | Да (20.11) |
| 8   | [FlowItem](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/flow#flow-item)                        | Ячейка «кладки»                                                                                                | Да | Без ячеек «кладка» не работает — следует из решения по Flow | Да (следует из № 7) |
| 9   | [Carousel](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/carousel)                              | Горизонтальная лента со стрелками, листается по слайдам                                                        | Нет    | Сравнивать варианты удобнее сеткой или таблицей; на телефоне сетка и так складывается в колонку |                   |
| 10  | [CarouselItem](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/carousel#carousel-item)            | Слайд ленты                                                                                                    | Нет    | Без Carousel не нужен                                                                           |                   |
| 11  | [CarouselMediaItem](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/carousel#carousel-media-item) | Слайд ленты с картинкой и подписью, щелчок — на весь экран                                                     | Нет    | Картинки-витрины, к тому же обычно с чужих серверов                                             |                   |
| 12  | [Spacer](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/spacer)                                  | Растягивающееся пустое место                                                                                   | Нет    | Сами разработчики пишут: «почти никогда не нужен, хватает промежутков»                          |                   |
| 13  | [Divider](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/divider)                                | Линия между группами, горизонтальная или вертикальная                                                          | Да     | Разделяет части карточки                                                                        |                   |
| 14  | [Tabs](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/tabs)                                      | Вкладки: видна одна панель за раз                                                                              | Да     | «Вариант А / Б», «Кратко / Подробно», по вкладке на год или отдел                               |                   |

## Текст

| №   | Компонент                                                                                           | Что это                                                                                  | Нужно? | Почему                                                                                   | Решение владельца |
| --- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- | ----------------- |
| 15  | [Title](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/title)                 | Заголовок внутри экрана (несколько размеров)                                             | Да     | Заголовок карточки, раздела                                                              |                   |
| 16  | [Text](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/text)                   | Абзац текста; внутри можно **жирный**, *курсив*, зачёркнутый, ссылку, `код`              | Да     | Основной текст внутри экрана                                                             |                   |
| 17  | [Caption](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/caption)             | Мелкий второстепенный текст: подсказка под полем, подпись слева в строке                 | Да     | Подписи и подсказки                                                                      |                   |
| 18  | [Label](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/label)                 | Подпись поля формы отдельным элементом                                                   | Нет    | У всех полей ввода своя подпись (`label`)                                                |                   |
| 19  | [Bold](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/bold)                   | Жирный кусок текста отдельным элементом                                                  | Нет    | То же делает разметка внутри Text                                                        |                   |
| 20  | [Italic](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/italic)               | Курсив отдельным элементом                                                               | Нет    | То же делает разметка внутри Text                                                        |                   |
| 21  | [Underline](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/underline)         | Подчёркнутый текст отдельным элементом                                                   | Нет    | То же делает разметка внутри Text                                                        |                   |
| 22  | [Strikethrough](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/strikethrough) | Зачёркнутый текст отдельным элементом                                                    | Нет    | То же делает разметка внутри Text                                                        |                   |
| 23  | [Badge](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/badge)                 | Плашка статуса: «Оплачен», «Просрочен», «В работе»; цвета успеха, ошибки, предупреждения | Да     | Статусы сделок, счетов, задач                                                            |                   |
| 24  | [Blockquote](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/blockquote)       | Цитата с чертой слева                                                                    | Нет    | Цитату из письма или договора агент пишет обычным текстом ответа, вне экрана             |                   |
| 25  | [Code](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/code)                   | Блок кода моноширинным шрифтом                                                           | Нет    | Код агент пишет обычным текстом ответа; сотрудникам он нужен редко                       |                   |
| 26  | [Markdown](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/markdown)           | Кусок обычного форматированного текста внутри экрана: в ячейке таблицы, рядом с графиком | Да     | Пояснение со списком или ссылками прямо в карточке                                       |                   |
| 27  | [Math](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/math)                   | Математическая формула (TeX)                                                             | Да | В CopilotKit формула показывается исходным текстом (`\frac{a}{b}`), набирающей библиотеки нет — нужен свой компонент с набором формул | Да (20.11) |
| 28  | [ShimmerText](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/shimmer-text)    | Текст с бегущим бликом «загружается»                                                     | Нет    | У нас свой блик ответа; внутри готового экрана «загрузки» нет                            |                   |
| 29  | [Link](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/link)                   | Ссылка (http, https, почта), открывается в новой вкладке                                 | Да     | Ссылки на сайты, документы, почту                                                        |                   |
| 30  | [Tooltip](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/tooltip)             | Подсказка при наведении или фокусе на значок, текст, плашку                              | Да     | Пояснение к показателю («как считается маржа»)                                           |                   |

## Ввод и действия

| № | Компонент | Что это | Нужно? | Почему | Решение владельца |
|---|---|---|---|---|---|
| 31 | [Button](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/button) | Кнопка: отправляет действие агенту, или открывает ссылку, или копирует текст; бывает главной, обычной, без рамки | Да | «Оформить КП», «Показать подробнее», «Скопировать» | |
| 32 | [Pressable](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/pressable) | Любая область, которую можно нажать: например, карточка целиком как кнопка | Нет | Хватает кнопки и выбора пункта в списке | |
| 33 | [Form](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/form) | Форма: собирает значения полей и отправляет их агенту одним действием (кнопкой или Enter) | Да | Заявки, параметры расчёта, данные клиента | |
| 34 | [TextField](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/text-field) | Поле ввода: одна строка или длинный текст, с маской (телефон, ИНН) | Да | Основное поле формы | |
| 35 | [TextArea](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/text-area) | Многострочное поле | Нет | У TextField есть вариант «длинный текст»; два поля для одного — лишний выбор для модели | |
| 36 | [Select](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/select) | Выпадающий список, можно с поиском | Да | Выбор из длинного списка: отдел, тариф, город | |
| 37 | [CheckBox](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/check-box) | Флажок «да / нет» | Да | Согласия, опции | |
| 38 | [Radio](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/radio) | Одиночная радиокнопка | Нет | Разработчики сами советуют вместо неё RadioGroup | |
| 39 | [RadioGroup](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/radio-group) | Выбор одного из нескольких вариантов кружками | Да | Выбор одного варианта с пояснениями | |
| 40 | [Slider](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/slider) | Ползунок для числа между минимумом и максимумом, с единицей измерения | Да | Калькуляторы: число сотрудников, срок, сумма | |
| 41 | [SegmentedControl](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/segmented-control) | Переключатель на 2–5 коротких вариантов в одну строку | Да | «Месяц / Квартал / Год»; такой же переключатель есть в макете (`Segmented`) | |
| 42 | [ChoicePicker](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/choice-picker) | Выбор одного или нескольких вариантов флажками или «таблетками» | Да | Выбор нескольких: услуги, отделы, каналы | |
| 43 | [DateTimeInput](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/date-time-input) | Выбор даты, времени или обоих; можно шаг (например, слоты по 30 минут) | Да | Даты сделок, встреч, сроков | |

## Данные

| № | Компонент | Что это | Нужно? | Почему | Решение владельца |
|---|---|---|---|---|---|
| 44 | [Table](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/table) | Таблица: колонки и строки, в ячейках могут быть плашки и кнопки, закреплённая шапка | Да | Главный способ показать данные | |
| 45 | [TableSection](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/table#table-section) | Группа строк таблицы: шапка или раздел | Да | Для сложных таблиц: разделы, шапка в несколько строк | |
| 46 | [TableRow](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/table#table-row) | Строка таблицы; может начинаться с ячейки-заголовка | Да | Для сложных таблиц: итоги, подзаголовки строк | |
| 47 | [TableCell](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/table#table-cell) | Ячейка; может объединять колонки и строки | Да | Для сложных таблиц: объединённые ячейки | |
| 48 | [List](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/list) | Список: пары «название — значение» или пункты; пункт можно выбрать | Да | Реквизиты, параметры, выбор из коротких вариантов | |
| 49 | [ListItem](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/list#list-item) | Пункт списка: название, значение справа, описание, значок, вложенные элементы | Да | Идёт вместе со списком | |
| 50 | [Chart](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/chart) | График: столбцы, линия, область, точки, круг, кольцо; подписи, легенда, формат денег | Да | Продажи по месяцам, доли, динамика | |
| 51 | [Map](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/map) | Карта с метками и маршрутом | Нет | Подложка карты грузится с чужих серверов — закрытая установка этого не позволяет; без неё вместо карты список мест | |

## Картинки и мультимедиа

| № | Компонент | Что это | Нужно? | Почему | Решение владельца |
|---|---|---|---|---|---|
| 52 | [Image](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/image) | Картинка по адресу; щелчок — на весь экран | Да, только с нашего сервера | Например, схема или график, которые агент сделал в папке проекта. Чужие адреса — нет (F36) | |
| 53 | [Icon](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/icon) | Значок из набора Lucide по имени | Да | Значки у пунктов, статусов, кнопок; набор лежит у нас, ничего снаружи не грузит | |
| 54 | [Favicon](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/favicon) | Значок сайта по его адресу | Нет | Грузится с чужого сайта (F36) | |
| 55 | [Svg](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/svg) | Векторный рисунок из простых фигур: линии, круги, прямоугольники, подписи | Нет | Модель рисует по координатам, и кривую картинку получить легко; схемы надёжнее собрать графиком или списком этапов | |
| 56 | [Video](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/video) | Видео по адресу или с YouTube | Нет | Чужие серверы (F36) | |
| 57 | [AudioPlayer](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/audio-player) | Проигрыватель звука по адресу | Нет | Сейчас нечего проигрывать со своего сервера; можно вернуть, если появятся, например, записи звонков у себя | |
| 58 | [HtmlView](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/html-view) | Произвольная HTML-страница в изолированной рамке, без скриптов | Нет | Вид не наш; всё нужное собирается из остальных. Можно вернуть позже как «запасной выход» для нестандартного | |

## Всплывающее

| № | Компонент | Что это | Нужно? | Почему | Решение владельца |
|---|---|---|---|---|---|
| 59 | [PulseIndicator](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/pulse-indicator) | Пульсирующая точка «онлайн / в работе» | Нет | Экран в ответе не живой, показывать нечего | |
| 60 | [FlashcardFlip](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/flashcard-flip) | Карточка-перевёртыш: щелчок показывает обратную сторону | Нет | Для обучения и тестов, не для рабочих ответов | |
| 61 | [Popover](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/popover) | Всплывающая панель по щелчку на подпись или значок | Да | Подробности строки или показателя без загромождения экрана | |
| 62 | [PopoverTrigger](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/popover#popover-trigger) | То, по чему щёлкают, чтобы открыть панель | Да | Идёт вместе с Popover | |
| 63 | [PopoverContent](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/popover#popover-content) | Содержимое всплывающей панели | Да | Идёт вместе с Popover | |
| 64 | [Modal](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/modal) | Окно поверх страницы, открывается кнопкой | Нет | Для ответа в чате тяжело: подробности удобнее вкладками или всплывающей панелью. Можно вернуть позже | |

## Готовые составные

| № | Компонент | Что это | Нужно? | Почему | Решение владельца |
|---|---|---|---|---|---|
| 65 | [LinkCard](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/link-card) | Превью ссылки: значок сайта, домен, заголовок, описание, картинка | Нет | Значок и картинку грузит с чужого сайта (F36); ссылку показывает Link, источник — Citation | |
| 66 | [Citation](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/citation) | Сноска [1] после фразы: по наведению или щелчку — источник, выдержка, ссылка | Да | Ответы по поиску в интернете со ссылками на источники | |
| 67 | [FollowUp](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/follow-up) | Кнопки-подсказки «что спросить дальше»: нажатие отправляет текст как сообщение сотрудника | Да | 2–4 следующих шага в конце экрана | |
| 68 | [EntityCard](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/entity-card) | Готовая карточка объекта: картинка, заголовок, подзаголовок, описание, цена, плашка, рейтинг, до 3 кнопок | Да, картинка только с нашего сервера | Карточка сделки, контакта, товара; заменяет нынешний блок «карточка» | |
| 69 | [ImageGrid](https://docs.copilotkit.ai/generative-ui/components/standard-catalog/image-grid) | Галерея картинок сеткой, щелчок — на весь экран | Нет | Картинки обычно с чужих серверов (F36); бизнесу галереи редко нужны | |

## Не компоненты, но идут вместе

Кроме компонентов, в набор входят **функции**. Они считаются в браузере, без обращения к модели:
- формулы пересчёта (`calc`) и построение рядов для графика (`series`);
- формат чисел, денег и дат;
- склонение слов по числу;
- проверки полей: обязательное, по шаблону, длина, число, адрес почты;
- открыть ссылку.

Они короткие и почти ничего не стоят в запросе. Рекомендация — **все**: без них не работают калькуляторы и проверки форм.
