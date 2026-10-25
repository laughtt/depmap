import { api, type Connection, type Project } from "./api";
import { ago, esc } from "./ui";
import { brand, nav, stateMsg, themeButton } from "./view";

const lock = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`;
const tanuki = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 21.5 3 14.6l1.5-4.7L7 2.5l2.6 7.4h4.8L17 2.5l2.5 7.4 1.5 4.7z" fill="currentColor"/></svg>`;

export function connectScreen(root: HTMLElement, connectionId?: string) {
  root.innerHTML = `<div class="screen plain-screen">
    <header class="topbar">${brand}${nav("")}<div class="spacer"></div>${themeButton()}</header>
    <main class="connect">
      <section class="connect-intro">
        <h1>Map a repository</h1>
        <p>Depmap reads the lockfile of a GitLab project, follows every dependency to the bottom of the tree and colours each one by how risky it is right now.</p>
        <ol class="steps">
          <li class="on"><b>Connect GitLab</b><span>Sign in, or paste a token with the read_api scope.</span></li>
          <li><b>Pick a project</b><span>Any project with a package-lock.json or pnpm-lock.yaml.</span></li>
          <li><b>Read the map</b><span>Red first. Each colour links to its source record.</span></li>
        </ol>
      </section>
      <section class="connect-card"></section>
    </main></div>`;
  const card = root.querySelector<HTMLElement>(".connect-card")!;
  const setStep = (k: number) => root.querySelectorAll(".steps li").forEach((li, j) => li.classList.toggle("on", j === k));

  const form = () => {
    setStep(0);
    card.innerHTML = `
      <form class="connect-form" novalidate>
        <label class="field"><span>GitLab URL</span><input name="gitlabUrl" type="url" value="http://localhost:8929" required spellcheck="false" autocomplete="url"><small class="err" hidden></small></label>
        <a class="btn oauth" href="#">${tanuki}<span>Continue with GitLab</span></a>
        <div class="or"><span>or use a personal access token</span></div>
        <label class="field"><span>Personal access token</span>
          <div class="pw"><input name="token" type="password" placeholder="glpat-…" required spellcheck="false" autocomplete="off"><button type="button" class="link show">Show</button></div>
          <small class="err" hidden></small></label>
        <p class="secure">${lock}<span>The token goes straight to the depmap server, which encrypts it with AES-256-GCM. It is never kept in this browser.</span></p>
        <div class="form-error" role="alert" hidden></div>
        <button class="btn primary" type="submit">Connect</button>
      </form>`;
    const f = card.querySelector<HTMLFormElement>("form")!;
    const url = f.elements.namedItem("gitlabUrl") as HTMLInputElement, token = f.elements.namedItem("token") as HTMLInputElement;
    const fieldErr = (i: HTMLInputElement, msg: string) => {
      const e = i.closest(".field")!.querySelector<HTMLElement>(".err")!;
      e.textContent = msg; e.hidden = !msg; i.setAttribute("aria-invalid", String(!!msg));
    };
    const validUrl = () => {
      try { const u = new URL(url.value.trim()); if (!/^https?:$/.test(u.protocol)) throw 0; fieldErr(url, ""); return true; }
      catch { fieldErr(url, "Enter the address of your GitLab, starting with http:// or https://"); return false; }
    };
    f.querySelector(".show")!.addEventListener("click", (e) => {
      token.type = token.type === "password" ? "text" : "password";
      (e.target as HTMLElement).textContent = token.type === "password" ? "Show" : "Hide";
    });
    f.querySelector(".oauth")!.addEventListener("click", (e) => {
      e.preventDefault();
      if (validUrl()) location.href = `/api/oauth/start?gitlabUrl=${encodeURIComponent(url.value.trim())}`;
    });
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const ok = validUrl();
      fieldErr(token, token.value.trim() ? "" : "Paste a personal access token, or use Continue with GitLab");
      if (!ok || !token.value.trim()) return (f.querySelector("[aria-invalid=true]") as HTMLInputElement)?.focus();
      const btn = f.querySelector<HTMLButtonElement>("button[type=submit]")!, err = f.querySelector<HTMLElement>(".form-error")!;
      btn.disabled = true; btn.textContent = "Connecting…"; err.hidden = true;
      try {
        const c = await api.connect(url.value.trim(), token.value.trim());
        token.value = "";
        projects(c);
      } catch (x) {
        err.hidden = false; err.textContent = (x as Error).message;
        btn.disabled = false; btn.textContent = "Connect";
      }
    });
  };

  const projects = async (c: Connection) => {
    setStep(1);
    const who = c.user?.username ?? c.username ?? "you";
    card.innerHTML = `<div class="projects"><header><div><h2>Pick a project</h2><p class="faint">Connected to ${esc(c.gitlabUrl)} as <b>${esc(who)}</b></p></div><button class="link" data-switch>Change</button></header>
      <input class="filter" type="search" placeholder="Filter projects" aria-label="Filter projects"><ul class="project-list"><li class="skeleton-row"></li><li class="skeleton-row"></li><li class="skeleton-row"></li></ul></div>`;
    card.querySelector("[data-switch]")!.addEventListener("click", form);
    const list = card.querySelector<HTMLElement>(".project-list")!, filter = card.querySelector<HTMLInputElement>(".filter")!;
    let all: Project[] = [];
    try {
      all = await api.projects(c.id);
    } catch (e) {
      list.outerHTML = stateMsg("Projects didn't load.", esc((e as Error).message));
      return;
    }
    const draw = () => {
      const q = filter.value.toLowerCase(), rows = all.filter((p) => p.pathWithNamespace.toLowerCase().includes(q));
      list.innerHTML = rows.length
        ? rows.map((p) => `<li><div><b>${esc(p.pathWithNamespace)}</b><span class="faint">${esc(p.defaultBranch)} · active ${ago(p.lastActivityAt)}</span></div><button class="btn" data-import="${p.id}">Import</button></li>`).join("")
        : `<li class="none">No project matches “${esc(filter.value)}”.</li>`;
    };
    filter.addEventListener("input", draw);
    list.addEventListener("click", async (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-import]");
      if (!b) return;
      list.querySelectorAll("button").forEach((x) => (x.disabled = true));
      b.textContent = "Importing…";
      b.closest("li")!.insertAdjacentHTML("beforeend", `<p class="importing">Reading the lockfile, package.json and sources, then scanning every package.</p>`);
      try {
        const r = await api.importProject(c.id, +b.dataset.import!);
        setStep(2);
        location.hash = `#/repo/${encodeURIComponent(r.repo)}/${r.snapshotId}?dig=1`;
      } catch (x) {
        draw();
        list.insertAdjacentHTML("beforebegin", `<div class="form-error" role="alert">${esc((x as Error).message)}</div>`);
      }
    });
    draw();
  };

  if (connectionId) {
    api.connections().then((cs) => {
      const c = cs.find((x) => x.id === connectionId);
      c ? projects(c) : form();
    }).catch(form);
  } else form();
}
