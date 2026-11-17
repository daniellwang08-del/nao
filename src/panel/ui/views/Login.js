import { html, useEffect, useState } from "../../../lib/preact.js";
import * as storage from "../../../storage.js";
import { changeServer, signIn, verifyCode } from "../../actions/session.js";
import { Banner, Button } from "../components.js";

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url || "";
  }
}

function ServerField({ backendUrl }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(backendUrl);
  const [error, setError] = useState(null);
  useEffect(() => setValue(backendUrl), [backendUrl]);

  const save = async (e) => {
    e.preventDefault();
    const err = await changeServer(value.trim() || null);
    setError(err);
    if (!err) setEditing(false);
  };
  const reset = async () => {
    setError(await changeServer(null));
    setEditing(false);
  };

  if (!editing) {
    return html`<p class="login-server">
      Server <strong>${hostOf(backendUrl)}</strong>
      <button type="button" class="link" onClick=${() => setEditing(true)}>Change</button>
    </p>`;
  }
  return html`<form class="login-server-form" onSubmit=${save}>
    <label class="field">
      <span class="field-label">Server address</span>
      <input class="input" type="url" value=${value} placeholder="https://nao.it.com" onInput=${(e) => setValue(e.currentTarget.value)} />
    </label>
    ${error ? html`<p class="field-error">${error}</p>` : null}
    <div class="row-actions">
      <${Button} variant="ghost" size="sm" onClick=${reset}>Use default</${Button}>
      <${Button} variant="secondary" size="sm" type="submit">Save</${Button}>
    </div>
  </form>`;
}

/** Two-step sign-in: the account has it on, so after the password comes a code from the authenticator app. */
function CodeStep({ ticket, email, remember, onBack }) {
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ready = backup ? code.trim().length >= 10 : code.length === 6;

  const submit = async (e) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    const err = await verifyCode({ ticket, code, email, remember });
    setBusy(false);
    if (err) {
      setError(err);
      setCode("");
    }
  };

  return html`<div class="login">
    <div class="login-brand">
      <img src="icons/icon128.png" alt="" width="44" height="44" />
      <h1>Two-step sign-in</h1>
      <p>${backup ? `Enter one of your backup codes for ${email}.` : `Enter the 6-digit code from your authenticator app for ${email}.`}</p>
    </div>
    <form class="login-form" onSubmit=${submit} noValidate>
      ${error ? html`<${Banner} tone="danger">${error}</${Banner}>` : null}
      <label class="field">
        <span class="field-label">${backup ? "Backup code" : "Code"}</span>
        <input
          class="input"
          id="nao-login-code"
          name="code"
          autocomplete="one-time-code"
          inputmode=${backup ? "text" : "numeric"}
          maxlength=${backup ? 11 : 6}
          placeholder=${backup ? "abcde-fghjk" : "123456"}
          value=${code}
          onInput=${(e) => setCode(backup ? e.currentTarget.value : e.currentTarget.value.replace(/\D/g, ""))}
          autofocus
        />
      </label>
      <${Button} variant="primary" type="submit" busy=${busy} disabled=${!ready} block>Verify and sign in</${Button}>
      <div class="row-actions">
        <button type="button" class="link" onClick=${onBack}>Back</button>
        <button
          type="button"
          class="link"
          onClick=${() => {
            setBackup(!backup);
            setCode("");
            setError(null);
          }}
        >
          ${backup ? "Use the app code" : "Lost your phone? Use a backup code"}
        </button>
      </div>
    </form>
  </div>`;
}

export function LoginView({ s }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [websiteOpened, setWebsiteOpened] = useState(false);
  const [mfa, setMfa] = useState(null);

  useEffect(() => {
    storage.getRememberedEmail().then((saved) => {
      if (saved) setEmail(saved);
    });
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await signIn({ email, password, remember });
    setBusy(false);
    if (result && typeof result === "object") {
      setPassword("");
      setMfa(result);
    } else if (result) setError(result);
  };

  const signInOnWebsite = () => {
    setWebsiteOpened(true);
    chrome.tabs.create({ url: `${s.backendUrl.replace(/\/+$/, "")}/extension/connect`, active: true }).catch(() => {});
  };

  if (mfa) {
    return html`<${CodeStep} ticket=${mfa.mfaTicket} email=${mfa.email || email.trim()} remember=${remember} onBack=${() => setMfa(null)} />`;
  }

  return html`<div class="login">
    <div class="login-brand">
      <img src="icons/icon128.png" alt="" width="44" height="44" />
      <h1>Sign in to NAO</h1>
      <p>Apply faster with tailored resumes and autofill.</p>
    </div>
    <div class="login-form">
      <${Button} variant="primary" block onClick=${signInOnWebsite}>Sign in with ${hostOf(s.backendUrl)}</${Button}>
      <p class="muted small">
        ${websiteOpened
          ? "Finish signing in on the website tab. This panel updates on its own."
          : "Uses your browser's saved password on the NAO website."}
      </p>
    </div>
    <p class="login-divider"><span>or use your email</span></p>
    <form class="login-form" onSubmit=${submit} noValidate>
      ${error ? html`<${Banner} tone="danger">${error}</${Banner}>` : null}
      <label class="field">
        <span class="field-label">Email</span>
        <input class="input" id="nao-login-email" name="email" type="email" inputmode="email" autocomplete="username" value=${email} onInput=${(e) => setEmail(e.currentTarget.value)} />
      </label>
      <label class="field">
        <span class="field-label">Password</span>
        <input class="input" id="nao-login-password" name="password" type="password" autocomplete="current-password" value=${password} onInput=${(e) => setPassword(e.currentTarget.value)} />
      </label>
      <label class="check">
        <input type="checkbox" checked=${remember} onChange=${(e) => setRemember(e.currentTarget.checked)} />
        <span>Remember my email</span>
      </label>
      <${Button} variant="secondary" type="submit" busy=${busy} block>Sign in</${Button}>
    </form>
    <${ServerField} backendUrl=${s.backendUrl} />
  </div>`;
}
