import { z } from 'zod';

// «Хранилище файлов» (spec, section 8.23): where the files of conversations and projects are stored —
// the server's disk or an S3 bucket the superadmin connected. Presets fill the address and the region of
// popular S3 services; «Другой» takes any S3-compatible one (MinIO, Amazon S3 and others).
export const STORAGE_PROVIDERS = ['yandex', 'selectel', 'vk', 'timeweb', 'other'] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

export interface StoragePreset {
  id: StorageProvider;
  title: string;
  // Empty for «Другой»: the admin types them.
  endpoint: string;
  region: string;
  // The bucket's name goes in the path of the address (path-style) rather than in the host name.
  pathStyle: boolean;
  // Where the admin makes the bucket and a key with rights to read and write it.
  help: string;
}

export const STORAGE_PRESETS: readonly StoragePreset[] = [
  {
    id: 'yandex',
    title: 'Yandex Object Storage',
    endpoint: 'https://storage.yandexcloud.net',
    region: 'ru-central1',
    pathStyle: true,
    help: 'Консоль Yandex Cloud → Object Storage → создайте бакет; ключ — сервисный аккаунт с ролью storage.editor → «Создать статический ключ доступа».',
  },
  {
    id: 'selectel',
    title: 'Selectel',
    endpoint: 'https://s3.ru-1.storage.selcloud.ru',
    region: 'ru-1',
    pathStyle: false,
    help: 'Панель Selectel → S3 → создайте бакет в пуле ru-1; ключ — сервисный пользователь с ролью «Администратор объектного хранилища» → S3-ключ.',
  },
  {
    id: 'vk',
    title: 'VK Cloud',
    endpoint: 'https://hb.ru-msk.vkcloud-storage.ru',
    region: 'ru-msk',
    pathStyle: true,
    help: 'Личный кабинет VK Cloud → Объектное хранилище → создайте бакет; «Аккаунты» → добавьте аккаунт и сохраните его ключи.',
  },
  {
    id: 'timeweb',
    title: 'Timeweb Cloud',
    endpoint: 'https://s3.twcstorage.ru',
    region: 'ru-1',
    pathStyle: true,
    help: 'Панель Timeweb Cloud → S3-хранилище → создайте бакет; ключи — во вкладке «Дашборд» бакета.',
  },
  {
    id: 'other',
    title: 'Другой S3-совместимый',
    endpoint: '',
    region: '',
    pathStyle: true,
    help: 'MinIO, Amazon S3 и любой другой сервис с протоколом S3: адрес сервиса и регион — из его документации.',
  },
];

const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
// A folder inside the bucket: letters, digits and «-_./», no «..», no leading «/».
const PREFIX = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\/?$/;

export const storageConnectSchema = z.object({
  provider: z.enum(STORAGE_PROVIDERS),
  endpoint: z.url({ protocol: /^https?$/ }),
  region: z.string().trim().min(1).max(64),
  bucket: z.string().trim().regex(BUCKET_NAME, 'Имя бакета: 3–63 строчные латинские буквы, цифры, точки и дефисы'),
  prefix: z.union([z.literal(''), z.string().trim().max(200).regex(PREFIX, 'Папка: латинские буквы, цифры и «-_/», без «..» и без «/» в начале')]),
  pathStyle: z.boolean(),
  accessKeyId: z.string().trim().min(1).max(256),
  secretAccessKey: z.string().trim().min(1).max(512),
});
export type StorageConnectInput = z.infer<typeof storageConnectSchema>;

export const storageKeysSchema = storageConnectSchema.pick({ accessKeyId: true, secretAccessKey: true });
export type StorageKeysInput = z.infer<typeof storageKeysSchema>;

// GET /app/api/admin/storage. Keys never leave the server.
export interface StorageStatus {
  mode: 'local' | 's3';
  // `to_s3` — files are being moved into the bucket, `to_local` — back onto the server's disk.
  state: 'active' | 'to_s3' | 'to_local';
  bucket: { provider: StorageProvider; endpoint: string; region: string; bucket: string; prefix: string; pathStyle: boolean; connectedAt: string } | null;
  // Stored in the bucket now.
  stored: { files: number; bytes: number };
  // Folders with a working copy on the disk now, and how many of them wait to be moved (`to_s3`, `to_local`).
  local: { folders: number; waiting: number };
  // The last failure of storing, cleared by the next success.
  lastError: { code: string; at: string } | null;
}
