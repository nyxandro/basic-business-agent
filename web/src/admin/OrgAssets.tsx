// «Бланк, печать и подпись» in «Профиль организации» (docs/specs/[20.11.2026]-org-letterhead.md, section 7): the letterhead
// with «Так начнётся документ агента», the logo, the director; the stamp, the signature and the responsible people only
// for a superadmin (F1) — the others read «Загружает суперадминистратор». Pictures are prepared in this browser before
// they leave (stamp-image.ts) and shown on a chequered field before «Сохранить».
import { signatureNameOf, type AdminPerson, type OrgAssetsState, type OrgDirector, type OrgPictureState } from '@bba/contracts';
import { useEffect, useRef, useState } from 'react';
import { ApiRequestError, asApiError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Button } from '../ui/Button.tsx';
import { Card, CardHead } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { useLoad } from '../ui/use-load.ts';
import { useDocumentViewer } from '../viewer/use-viewer.tsx';
import { adminApi } from './api.ts';
import styles from './org-assets.module.css';
import { Checklist, Feedback, useAction } from './parts.tsx';
import section from './section.module.css';
import { OrgImageError, prepareOrgImage, type OrgPictureKind } from './stamp-image.ts';

const t = ru.org;
const A = '/app/api/admin/org-assets';
const PICTURE_TITLES: Record<OrgPictureKind, string> = { logo: t.logo, stamp: t.stamp, signature: t.signature };

function pickError(error: unknown): ApiRequestError {
  if (!(error instanceof OrgImageError)) return asApiError(error);
  // Not the file but the browser: the details are kept for diagnosis.
  if (error.reason === 'not-prepared') console.error('org image preparation failed', error);
  const message = { 'too-big': t.tooBig, unreadable: t.unreadable, empty: t.emptyPicture, 'not-prepared': t.notPrepared }[error.reason];
  return new ApiRequestError({ code: 'APP_ORG_IMAGE_PREPARE_FAILED', message, status: 0, cause: error });
}

function FilePick({ accept, label, busy, children, onFile }: { accept: string; label: string; busy: boolean; children: string; onFile: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        aria-label={`${label}: ${t.chooseFile}`}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          // The same file chosen again after an error must fire the change again.
          e.currentTarget.value = '';
          if (file) onFile(file);
        }}
      />
      <Button icon="plus" disabled={busy} onClick={() => input.current?.click()}>
        {children}
      </Button>
    </>
  );
}

type Update = (next: OrgAssetsState) => void;

function BlankRow({ state, onChange }: { state: OrgAssetsState; onChange: Update }) {
  const { busy, error, run } = useAction();
  const confirm = useConfirm();
  const viewer = useDocumentViewer();
  const blank = state.blank;
  // The letterhead was drawn in the body and nothing of it is left without the line [[ТЕКСТ]].
  const lost = blank !== null && !blank.info.mark && (!blank.info.header || blank.info.bodyDrawing);
  const upload = (file: File) => void run(async () => onChange(await adminApi.uploadOrgAsset('blank', file, file.name)));
  return (
    <div className={styles.row} role="group" aria-label={t.blank}>
      <div className={styles.rowHead}>
        <span className={styles.label}>{t.blank}</span>
        {blank ? <span className={styles.fileName}>{blank.fileName}</span> : <span className={section.sub}>{t.blankEmpty}</span>}
      </div>
      {busy ? <div className={section.sub} role="status">{t.blankUploading}</div> : null}
      {lost ? <div className={styles.attention} role="note">{t.blankHint}</div> : null}
      <Feedback error={error} />
      <div className={styles.actions}>
        {blank ? (
          <Button icon="eye" onClick={() => viewer.open({ name: blank.fileName, downloadUrl: `${A}/blank/file`, previewUrl: `${A}/blank/preview` })}>
            {t.blankPreview}
          </Button>
        ) : null}
        <FilePick accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" label={t.blank} busy={busy} onFile={upload}>
          {blank ? t.replace : t.choose}
        </FilePick>
        {blank ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void confirm({ title: t.removeTitle(t.blank), text: t.removeText, confirmLabel: t.remove, danger: true }).then((yes) => {
                if (yes) void run(async () => onChange(await adminApi.removeOrgAsset('blank')));
              })
            }
          >
            {t.remove}
          </Button>
        ) : null}
      </div>
      {viewer.viewer}
    </div>
  );
}

// A picture prepared in this browser and not saved yet; its address lives while it is shown.
type Picked = { file: File; blob: Blob; url: string };

function PictureRow({ kind, picture, warning, onChange }: { kind: OrgPictureKind; picture: OrgPictureState | null; warning?: string | null; onChange: Update }) {
  const [removeWhite, setRemoveWhite] = useState(kind !== 'logo');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [pickFailure, setPickFailure] = useState<ApiRequestError | null>(null);
  const { busy, error, run } = useAction();
  const confirm = useConfirm();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => () => {
    if (picked) URL.revokeObjectURL(picked.url);
  }, [picked]);

  async function prepare(file: File, white: boolean) {
    setPickFailure(null);
    setPreparing(true);
    try {
      const blob = await prepareOrgImage(file, kind, white);
      if (mounted.current) setPicked({ file, blob, url: URL.createObjectURL(blob) });
    } catch (raw) {
      setPickFailure(pickError(raw));
    } finally {
      setPreparing(false);
    }
  }

  const shown = picked?.url ?? (picture ? `${A}/${kind}/file?v=${picture.version}` : null);
  return (
    <div className={styles.row} role="group" aria-label={PICTURE_TITLES[kind]}>
      <span className={styles.label}>{PICTURE_TITLES[kind]}</span>
      {warning ? <div className={styles.attention} role="note">{warning}</div> : null}
      <div className={styles.picture}>
        {/* Light in both themes: the picture lies on white paper. */}
        <span className={styles.checker} title={t.checkerboard} data-theme-scope="light">
          {shown ? <img src={shown} alt={PICTURE_TITLES[kind]} className={styles.pictureImg} /> : null}
        </span>
        <div className={styles.pictureSide}>
          {shown ? null : <span className={section.sub}>{t.pictureEmpty}</span>}
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={removeWhite}
              disabled={preparing || busy}
              onChange={(e) => {
                const next = e.currentTarget.checked;
                setRemoveWhite(next);
                if (picked) void prepare(picked.file, next);
              }}
            />
            {t.removeWhite}
          </label>
          <div className={styles.actions}>
            {picked ? (
              <>
                <Button variant="primary" disabled={busy || preparing} onClick={() => void run(async () => {
                  onChange(await adminApi.uploadOrgAsset(kind, picked.blob, `${kind}.png`));
                  setPicked(null);
                })}>
                  {t.save}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setPicked(null)}>
                  {t.cancel}
                </Button>
              </>
            ) : (
              <FilePick accept="image/png,image/jpeg" label={PICTURE_TITLES[kind]} busy={preparing || busy} onFile={(file) => void prepare(file, removeWhite)}>
                {preparing ? t.preparing : picture ? t.replace : t.choose}
              </FilePick>
            )}
            {picture && !picked ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void confirm({ title: t.removeTitle(PICTURE_TITLES[kind]), text: t.removeText, confirmLabel: t.remove, danger: true }).then((yes) => {
                    if (yes) void run(async () => onChange(await adminApi.removeOrgAsset(kind)));
                  })
                }
              >
                {t.remove}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      {pickFailure ? <ErrorBanner error={pickFailure} /> : null}
      <Feedback error={error} />
    </div>
  );
}

function DirectorCard({ initial, onChange }: { initial: OrgDirector; onChange: Update }) {
  const [form, setForm] = useState(initial);
  const { busy, error, run } = useAction();
  // The signature name follows the full name until the admin writes their own.
  const follows = form.signatureName === '' || form.signatureName === signatureNameOf(form.fullName);
  const changed = form.position !== initial.position || form.fullName !== initial.fullName || form.signatureName !== initial.signatureName;
  return (
    <Card as="section" label={t.director} className="rise">
      <CardHead title={t.director} sub={t.directorSub} />
      <div className={styles.body}>
        <Field label={t.position}>
          <Input value={form.position} maxLength={200} onChange={(e) => setForm({ ...form, position: e.target.value })} />
        </Field>
        <Field label={t.fullName}>
          <Input
            value={form.fullName}
            maxLength={200}
            onChange={(e) => {
              const fullName = e.target.value;
              setForm({ ...form, fullName, signatureName: follows ? signatureNameOf(fullName) : form.signatureName });
            }}
          />
        </Field>
        <Field label={t.signatureName} hint={t.signatureNameHint}>
          <Input value={form.signatureName} maxLength={200} onChange={(e) => setForm({ ...form, signatureName: e.target.value })} />
        </Field>
        <Feedback error={error} />
        <div className={styles.foot}>
          <Button variant="primary" disabled={busy || !changed} onClick={() => void run(async () => onChange(await adminApi.saveOrgDirector(form)))}>
            {t.save}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function SignersCard({ state, onChange }: { state: NonNullable<OrgAssetsState['seal']>; onChange: Update }) {
  const people = useLoad(adminApi.people, ['admin', 'people']);
  const [selected, setSelected] = useState(state.signers.map((s) => s.userId));
  const { busy, error, run } = useAction();
  const saved = state.signers.map((s) => s.userId);
  const changed = selected.length !== saved.length || selected.some((id) => !saved.includes(id));
  // People who are signers but not listed (a fresh list of people not loaded yet) still show by name.
  const items = (people.state.status === 'ready' ? people.state.data.people : ([] as AdminPerson[])).map((p) => ({ id: p.id, label: p.name }));
  for (const s of state.signers) if (!items.some((i) => i.id === s.userId)) items.push({ id: s.userId, label: s.name });
  return (
    <Card as="section" label={t.signers} className="rise">
      <CardHead title={t.signers} sub={t.signersSub} />
      <div className={styles.body}>
        <span className={section.sub}>{saved.length === 0 ? t.signersEmpty : t.signersCount(saved.length)}</span>
        {people.state.status === 'error' ? <ErrorBanner error={people.state.error} onRetry={people.reload} /> : null}
        <Checklist legend={t.people} items={items} selected={selected} onChange={setSelected} disabled={busy} />
        <Feedback error={error} />
        <div className={styles.foot}>
          <Button variant="primary" disabled={busy || !changed} onClick={() => void run(async () => onChange(await adminApi.saveOrgSigners(selected)))}>
            {t.save}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Loaded({ initial }: { initial: OrgAssetsState }) {
  const [state, setState] = useState(initial);
  const seal = state.seal;
  const oldSignature = seal?.signature?.director && state.director.fullName && seal.signature.director !== state.director.fullName ? seal.signature.director : null;
  return (
    <>
      <Card as="section" label={t.title} className="rise">
        <CardHead title={t.title} sub={t.sub} />
        <div className={styles.body}>
          <BlankRow state={state} onChange={setState} />
          <PictureRow kind="logo" picture={state.logo} onChange={setState} />
          {seal ? (
            <>
              <PictureRow kind="stamp" picture={seal.stamp} onChange={setState} />
              <PictureRow kind="signature" picture={seal.signature} warning={oldSignature ? t.oldSignature(oldSignature) : null} onChange={setState} />
              <p className={styles.warning}>{t.copyWarning}</p>
            </>
          ) : (
            <div className={styles.row}>
              <span className={styles.label}>{`${t.stamp} и ${t.signature.toLowerCase()}`}</span>
              <span className={section.sub}>{t.superadminOnly}</span>
            </div>
          )}
        </div>
      </Card>
      <DirectorCard initial={state.director} onChange={setState} />
      {seal ? <SignersCard state={seal} onChange={setState} /> : null}
    </>
  );
}

export function OrgAssets() {
  // A form starts from what it loads: loaded anew at every opening, never from memory (spec, section 8.22).
  const { state, reload } = useLoad(adminApi.orgAssets);
  if (state.status === 'loading') return <DelayedBar />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  return <Loaded initial={state.data} />;
}
