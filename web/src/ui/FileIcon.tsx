// The icon of a file by its extension (decision of the owner 15.11): the type is written on the icon
// (PDF, DOC, XLS…) and coloured, in the line style of the interface — Phosphor icons, duotone. Each
// icon is imported on its own, so only these get into the bundle. An unknown type is a plain page.
import type { Icon as PhosphorIcon } from '@phosphor-icons/react/dist/lib/types';
import { FileIcon as PlainFile } from '@phosphor-icons/react/dist/csr/File';
import { FileAudioIcon } from '@phosphor-icons/react/dist/csr/FileAudio';
import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import { FileCsvIcon } from '@phosphor-icons/react/dist/csr/FileCsv';
import { FileDocIcon } from '@phosphor-icons/react/dist/csr/FileDoc';
import { FileHtmlIcon } from '@phosphor-icons/react/dist/csr/FileHtml';
import { FileImageIcon } from '@phosphor-icons/react/dist/csr/FileImage';
import { FileJpgIcon } from '@phosphor-icons/react/dist/csr/FileJpg';
import { FileMdIcon } from '@phosphor-icons/react/dist/csr/FileMd';
import { FilePdfIcon } from '@phosphor-icons/react/dist/csr/FilePdf';
import { FilePngIcon } from '@phosphor-icons/react/dist/csr/FilePng';
import { FilePptIcon } from '@phosphor-icons/react/dist/csr/FilePpt';
import { FileSvgIcon } from '@phosphor-icons/react/dist/csr/FileSvg';
import { FileTxtIcon } from '@phosphor-icons/react/dist/csr/FileTxt';
import { FileVideoIcon } from '@phosphor-icons/react/dist/csr/FileVideo';
import { FileXlsIcon } from '@phosphor-icons/react/dist/csr/FileXls';
import { FileZipIcon } from '@phosphor-icons/react/dist/csr/FileZip';

// The colour of each kind is a token of the theme (--file-<kind>, ui/theme/tokens.css).
type Kind = 'pdf' | 'doc' | 'sheet' | 'slides' | 'image' | 'media' | 'archive' | 'plain';

const TYPES: Record<string, { glyph: PhosphorIcon; kind: Kind }> = {};
const add = (glyph: PhosphorIcon, kind: Kind, extensions: string[]) => extensions.forEach((ext) => (TYPES[ext] = { glyph, kind }));
add(FilePdfIcon, 'pdf', ['pdf']);
add(FileDocIcon, 'doc', ['doc', 'docx', 'odt', 'rtf']);
add(FileXlsIcon, 'sheet', ['xls', 'xlsx', 'xlsm', 'ods']);
add(FileCsvIcon, 'sheet', ['csv', 'tsv']);
add(FilePptIcon, 'slides', ['ppt', 'pptx', 'odp']);
add(FileJpgIcon, 'image', ['jpg', 'jpeg']);
add(FilePngIcon, 'image', ['png']);
add(FileSvgIcon, 'image', ['svg']);
add(FileImageIcon, 'image', ['gif', 'webp', 'heic', 'bmp', 'tif', 'tiff']);
add(FileAudioIcon, 'media', ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']);
add(FileVideoIcon, 'media', ['mp4', 'mov', 'avi', 'mkv', 'webm']);
add(FileZipIcon, 'archive', ['zip', 'rar', '7z', 'tar', 'gz', 'tgz']);
add(FileTxtIcon, 'plain', ['txt', 'log']);
add(FileMdIcon, 'plain', ['md']);
add(FileHtmlIcon, 'plain', ['html', 'htm']);
add(FileCodeIcon, 'plain', ['json', 'xml', 'yaml', 'yml', 'sql', 'js', 'ts', 'py']);

// «Смета.XLSX» → xlsx; «archive.tar.gz» → gz; «.env» and «README» have none.
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

// Decorative: the name of the file is always next to it.
export function FileIcon({ name, size = 18 }: { name: string; size?: number }) {
  const type = TYPES[extensionOf(name)];
  const Glyph = type?.glyph ?? PlainFile;
  return <Glyph size={size} weight="duotone" aria-hidden="true" style={{ color: `var(--file-${type?.kind ?? 'plain'})`, flex: 'none' }} />;
}
