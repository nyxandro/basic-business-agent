// What a person's Office file is before any program opens it — shared by the viewer (spec, section 8.27) and
// the text of attached documents (8.29): a new format with a password is an OLE container, not a zip; an
// archive that unpacks into gigabytes would hold LibreOffice and the memory of the container.
import { unzipSync } from 'fflate';
import { open } from 'node:fs/promises';

// The formats of Office that are zip archives: one beginning as an OLE container is encrypted.
export const ZIPPED_OFFICE = new Set(['.docx', '.docm', '.dotx', '.xlsx', '.xlsm', '.pptx', '.ppsx']);
// Formats that are zip archives: what their archive says it unpacks into is checked first.
export const ZIPPED_FORMATS = new Set([...ZIPPED_OFFICE, '.odt', '.ods', '.odp']);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

async function startsWith(path: string, magic: Buffer): Promise<boolean> {
  const file = await open(path, 'r');
  try {
    const head = Buffer.alloc(magic.length);
    const { bytesRead } = await file.read(head, 0, magic.length, 0);
    return bytesRead === magic.length && head.equals(magic);
  } finally {
    await file.close();
  }
}

// A new format of Office (`ext` among ZIPPED_OFFICE) with a password.
export async function isEncryptedOffice(path: string): Promise<boolean> {
  return startsWith(path, OLE_MAGIC);
}

// What the archive of a document says it unpacks into, read from its directory without unpacking; null — not
// a zip archive (the program that reads it says what it is).
export function unpackedBytesOf(bytes: Uint8Array): number | null {
  let total = 0;
  try {
    unzipSync(bytes, {
      filter: (file) => {
        total += file.originalSize;
        return false;
      },
    });
  } catch {
    return null;
  }
  return total;
}
