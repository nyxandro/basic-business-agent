// Sections of the admin panel in menu order and groups (mockup «Админка»), and who may open them:
// a section opens with any of its rights. Kept light — the side panel of the chat reads it to
// show «Админка», while the panel itself loads separately.
import type { AdminSection, MeResponse } from '@bba/contracts';
import type { IconName } from '../ui/Icon.tsx';

export interface SectionDef {
  path: string;
  label: string;
  icon: IconName;
  group: string;
  rights: AdminSection[];
}

export const SECTIONS: SectionDef[] = [
  { path: 'models', label: 'Нейросеть', icon: 'cpu', group: 'Нейросеть', rights: ['models'] },
  { path: 'masking', label: 'Маскирование', icon: 'shield', group: 'Нейросеть', rights: ['masking'] },
  { path: 'limits', label: 'Лимиты и расходы', icon: 'wallet', group: 'Нейросеть', rights: ['limits', 'usage'] },
  { path: 'agents', label: 'Агенты и промпты', icon: 'bot', group: 'Агенты', rights: ['agents'] },
  { path: 'skills', label: 'Скиллы', icon: 'layers', group: 'Агенты', rights: ['skills'] },
  { path: 'users', label: 'Сотрудники', icon: 'users', group: 'Люди', rights: ['users'] },
  { path: 'departments', label: 'Отделы', icon: 'building', group: 'Люди', rights: ['departments'] },
  { path: 'roles', label: 'Роли', icon: 'key', group: 'Люди', rights: ['roles'] },
  { path: 'connections', label: 'Подключения', icon: 'plug', group: 'Система', rights: ['connections'] },
  { path: 'journal', label: 'Журнал действий', icon: 'list', group: 'Система', rights: ['journal'] },
  { path: 'org-profile', label: 'Профиль организации', icon: 'org', group: 'Система', rights: ['org_profile'] },
];

// Names of rights in the role editor; the document rights are reserved for the knowledge base.
export const PERMISSION_LABELS: Record<string, string> = {
  users: 'Сотрудники',
  roles: 'Роли',
  departments: 'Отделы',
  limits: 'Лимиты',
  usage: 'Расходы',
  agents: 'Агенты, промпты и режимы работы',
  org_profile: 'Профиль организации',
  masking: 'Маскирование',
  connections: 'Подключения',
  journal: 'Журнал действий',
  models: 'Нейросеть',
  skills: 'Скиллы',
  'documents.org.manage': 'Документы организации',
  'documents.department.manage': 'Документы отдела',
};

export const hasRight = (me: MeResponse, right: AdminSection): boolean => me.isSuperadmin || me.permissions.includes(right);

export const canOpen = (me: MeResponse, section: SectionDef): boolean => section.rights.some((r) => hasRight(me, r));

export const availableSections = (me: MeResponse): SectionDef[] => SECTIONS.filter((s) => canOpen(me, s));

export function sectionByPath(path: string): SectionDef {
  const found = SECTIONS.find((s) => s.path === path);
  if (!found) throw new Error(`no admin section "${path}"`);
  return found;
}
