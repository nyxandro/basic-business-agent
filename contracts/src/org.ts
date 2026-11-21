// The letterhead, the logo, the stamp and the signature of the organisation, and its director
// (docs/specs/[20.11.2026]-org-letterhead.md): «Профиль организации» of the admin panel.
import { z } from 'zod';

export const ORG_ASSET_KINDS = ['blank', 'logo', 'stamp', 'signature'] as const;
export type OrgAssetKind = (typeof ORG_ASSET_KINDS)[number];
// Uploaded only by a superadmin and seen only by them (F1 and the independent review 20.11).
export const SUPERADMIN_ASSETS: ReadonlySet<OrgAssetKind> = new Set(['stamp', 'signature']);

export const ORG_BLANK_MAX_BYTES = 5 * 1024 * 1024;
// A picture after the browser prepared it (a scan from a phone may be bigger before).
export const ORG_IMAGE_MAX_BYTES = 1024 * 1024;
// The stamp and the signature: wide enough to print sharp at 4 cm.
export const ORG_STAMP_WIDTH_PX = 600;
// The logo is also put on slides: it keeps more points.
export const ORG_LOGO_MAX_SIDE_PX = 1200;

export interface BlankInfo {
  // The line [[ТЕКСТ]] was found: everything above it stays in the documents.
  mark: boolean;
  // The headers or footers show something.
  header: boolean;
  // A table or a picture was among the text removed: the letterhead was likely drawn in the body.
  bodyDrawing: boolean;
}

export interface OrgBlankState {
  fileName: string;
  updatedAt: string;
  info: BlankInfo;
}

export interface OrgPictureState {
  width: number;
  height: number;
  updatedAt: string;
  // Of the picture's address: a new picture is fetched anew.
  version: string;
}

export interface OrgSigner {
  userId: string;
  name: string;
  email: string;
}

export interface OrgDirector {
  position: string;
  fullName: string;
  signatureName: string;
}

export interface OrgAssetsState {
  blank: OrgBlankState | null;
  logo: OrgPictureState | null;
  director: OrgDirector;
  // Only for a superadmin: the stamp, the signature and the responsible people.
  seal: {
    stamp: OrgPictureState | null;
    signature: (OrgPictureState & { director: string | null }) | null;
    signers: OrgSigner[];
  } | null;
}

// «Иванов Иван Петрович» → «И. П. Иванов»; without a patronymic — «И. Иванов». A double surname stays whole.
export function signatureNameOf(fullName: string): string {
  const [surname, ...rest] = fullName.trim().split(/\s+/).filter(Boolean);
  if (!surname || rest.length === 0) return '';
  const initials = rest.map((part) => `${part[0]!.toUpperCase()}.`).join(' ');
  return `${initials} ${surname}`;
}

// The full name is a surname and a name at least (a patronymic, if there is one); empty — no director yet.
export const orgDirectorSchema = z
  .object({
    position: z.string().trim().max(200),
    fullName: z.string().trim().max(200),
    signatureName: z.string().trim().max(200),
  })
  .refine((d) => d.fullName === '' || d.fullName.split(/\s+/).length >= 2, { path: ['fullName'], message: 'surname and name' });

export const orgSignersSchema = z.object({ userIds: z.array(z.string().min(1)).max(500) });
