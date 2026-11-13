// Texts of the interface (spec, sections 7, 9 and 12). Server errors bring their own Russian text;
// here are only the texts of the screens and of the errors the browser detects itself.
export const ru = {
  app: { title: 'Агенты' },
  menu: {
    agents: 'Агенты',
    signOut: 'Выйти',
  },
  common: {
    retry: 'Повторить',
    loading: 'Загрузка…',
    errorCode: 'Код ошибки',
    signInAgain: 'Войти заново',
  },
  login: {
    title: 'Вход',
    email: 'Почта',
    password: 'Пароль',
    submit: 'Войти',
    submitting: 'Входим…',
  },
  password: {
    password: 'Новый пароль',
    repeat: 'Повторите пароль',
    tooShort: (min: number) => `Пароль слишком короткий: нужно не меньше ${min} символов.`,
    mismatch: 'Пароли не совпадают.',
  },
  invite: {
    title: 'Приглашение',
    greeting: (name: string) => `Здравствуйте, ${name}! Придумайте пароль для входа.`,
    submit: 'Сохранить пароль и войти',
  },
  reset: {
    title: 'Смена пароля',
    lead: (email: string) => `Новый пароль для ${email}.`,
    submit: 'Сменить пароль и войти',
  },
  saving: 'Сохраняем…',
  agents: {
    title: 'Агенты',
    empty: 'Вам пока не открыт ни один агент. Администратор назначает агентов через отделы — напишите ему.',
    loadFailed: 'Не удалось загрузить список агентов',
  },
  // Errors the browser detects itself: the server did not answer or answered not in our format.
  clientErrors: {
    APP_NETWORK_FAILED: 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.',
    APP_SERVER_UNAVAILABLE: 'Сервер сейчас не отвечает. Попробуйте через минуту; если повторяется — сообщите администратору код ошибки.',
  },
} as const;
