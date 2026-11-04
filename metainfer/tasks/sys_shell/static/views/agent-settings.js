// Platform-wide coding-agent backend selector. Saves through
// /api/sys-shell/agent-backend; the launcher applies it to new orchestrators.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";

const API = "/api/sys-shell/agent-backend";

async function request(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      message = body.detail || message;
    } catch (_) { /* keep status */ }
    throw new Error(message);
  }
  return response.json();
}

export function AgentSettings({ onClose }) {
  const [data, setData] = useState(null);
  const [backend, setBackend] = useState("dsh");
  const [dshBin, setDshBin] = useState("dsh");
  const [dshProfile, setDshProfile] = useState("metainfer-headless");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    request(API)
      .then((value) => {
        setData(value);
        setBackend(value.backend || "dsh");
        setDshBin(value.dshBin || "dsh");
        setDshProfile(value.dshProfile || "metainfer-headless");
      })
      .catch((reason) => setError(String(reason.message || reason)));
  }, []);

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const value = await request(API, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ backend, dshBin, dshProfile }),
      });
      setData(value);
      setBackend(value.backend);
      setDshBin(value.dshBin);
      setDshProfile(value.dshProfile || "metainfer-headless");
      setData((previous) => ({ ...(previous || {}), ...value }));
      setSaved(true);
    } catch (reason) {
      setError(String(reason.message || reason));
    } finally {
      setSaving(false);
    }
  };

  return html`
    <div class="agent-settings-backdrop" onClick=${onClose}>
      <form class="agent-settings" onClick=${(event) => event.stopPropagation()} onSubmit=${save}>
        <div class="agent-settings-head">
          <div>
            <h2>Agent runtime</h2>
            <p class="traj-hint">Applied to newly launched task orchestrators. Running tasks keep their backend.</p>
          </div>
          <button class="btn ghost" type="button" onClick=${onClose}>Close</button>
        </div>
        ${data ? html`
          <div class="agent-settings-current">
            current: <b>${data.backend}</b> · source: <span class="mono">${data.source}</span>
          </div>
        ` : null}
        <label class="agent-settings-field">
          <span>Backend</span>
          <select value=${backend} onChange=${(event) => setBackend(event.target.value)}>
            <option value="dsh">dsh — DeepSeek Harness</option>
            <option value="claude">claude</option>
            <option value="codex">codex</option>
            <option value="pi">pi</option>
          </select>
        </label>
        ${backend === "dsh" ? html`
          <label class="agent-settings-field">
            <span>DSH binary</span>
            <input value=${dshBin} placeholder="dsh"
                onInput=${(event) => setDshBin(event.target.value)} />
          </label>
          <label class="agent-settings-field">
            <span>DSH profile</span>
            <input value=${dshProfile} placeholder="metainfer-headless"
                onInput=${(event) => setDshProfile(event.target.value)} />
          </label>
          <p class="traj-hint">
            Uses <code>dsh --profile ${dshProfile} --json</code>. Saving creates the
            authenticated <code>metainfer-headless</code> profile when it is absent.
          </p>
          ${data?.dshProfilePath ? html`
            <div class="agent-settings-current">
              profile: <span class="mono">${data.dshProfilePath}</span>
              · ${data.dshProfileExists ? "exists" : "not created yet"}
            </div>
          ` : null}
        ` : html`
          <p class="traj-hint">The selected backend relies on its own CLI/configuration.</p>
        `}
        ${error ? html`<div class="agent-settings-error">${error}</div>` : null}
        ${saved ? html`<div class="agent-settings-saved">Saved. New tasks will use this backend.</div>` : null}
        <div class="agent-settings-actions">
          <button class="btn primary" type="submit" disabled=${saving}>
            ${saving ? "Saving…" : "Save runtime"}
          </button>
          <button class="btn ghost" type="button" onClick=${onClose}>Cancel</button>
        </div>
      </form>
    </div>
  `;
}
