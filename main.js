var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => EchoRecallPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var ECHO_DASHBOARD_VIEW_TYPE = "echo-dashboard-view";
var ECHO_REVISION_VIEW_TYPE = "echo-revision-view";
var DEFAULT_SETTINGS = {
  skipCallouts: true,
  skipCheckboxes: true,
  skipQuotes: false,
  excludeInternalLinks: true,
  excludeExternalLinks: true,
  excludeEmbeds: true,
  customRegex: "",
  enableQuickLook: true,
  interleaveDueQueue: false
};
var LEECH_REVISIONS = 8;
function interleaveByTag(data) {
  const groups = /* @__PURE__ */ new Map();
  for (const d of data) {
    const key = d.tags.length ? d.tags[0] : "__untagged__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d.file);
  }
  const lists = Array.from(groups.values());
  const out = [];
  for (let i = 0, added = true; added; i++) {
    added = false;
    for (const list of lists) {
      if (i < list.length) {
        out.push(list[i]);
        added = true;
      }
    }
  }
  return out;
}
function getToday() {
  return window.moment().format("YYYY-MM-DD");
}
function calculateNextDue(confidence, deadlineStr) {
  let days = 1;
  if (confidence === "Moderate") days = 7;
  if (confidence === "Easy") days = 14;
  if (deadlineStr && confidence !== "Easy") {
    const today = window.moment();
    const deadlineDate = window.moment(deadlineStr, "YYYY-MM-DD");
    const daysRemaining = deadlineDate.diff(today, "days");
    if (daysRemaining > 0 && daysRemaining < days) {
      days = Math.max(1, Math.floor(daysRemaining * 0.5));
    }
  }
  return window.moment().add(days, "days").format("YYYY-MM-DD");
}
async function updateNoteFrontmatter(app, file, updates) {
  await app.fileManager.processFrontMatter(file, (fm) => {
    if (updates.echo_date_added !== void 0) fm["echo_date_added"] = updates.echo_date_added;
    if (updates.echo_last_revised !== void 0) fm["echo_last_revised"] = updates.echo_last_revised;
    if (updates.echo_revision_count !== void 0) fm["echo_revision_count"] = updates.echo_revision_count;
    if (updates.echo_confidence !== void 0) fm["echo_confidence"] = updates.echo_confidence;
    if (updates.echo_next_due !== void 0) fm["echo_next_due"] = updates.echo_next_due;
    if (updates.echo_tags !== void 0) fm["echo_tags"] = updates.echo_tags;
    if (updates.echo_deadline !== void 0) fm["echo_deadline"] = updates.echo_deadline;
    if (updates.echo_history !== void 0) fm["echo_history"] = updates.echo_history;
    if (updates.echo_archived !== void 0) fm["echo_archived"] = updates.echo_archived;
  });
}
function extractFrontmatter(text) {
  const match = text.match(/^---\n[\s\S]*?\n---\n/);
  if (match) {
    return { frontmatter: match[0], body: text.slice(match[0].length) };
  }
  return { frontmatter: "", body: text };
}
var RevisionItemView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  plugin;
  queue = [];
  currentIndex = 0;
  currentStep = 1;
  scrollPos = 0;
  confidence = "Hard";
  originalTexts = /* @__PURE__ */ new WeakMap();
  isDomWrapped = false;
  headerTitle;
  headerCount;
  topDirective;
  mdContainer;
  bottomSection;
  bottomDirectiveText;
  btnBack;
  btnNext;
  btnFinish;
  getViewType() {
    return ECHO_REVISION_VIEW_TYPE;
  }
  getDisplayText() {
    return "Echo Recall Session";
  }
  getIcon() {
    return "brain-circuit";
  }
  async startSession(files) {
    if (files.length === 0) return;
    this.queue = files;
    this.currentIndex = 0;
    if (!this.mdContainer) {
      this.buildUI();
    }
    await this.loadCurrentNote();
    this.app.workspace.revealLeaf(this.leaf);
  }
  buildUI() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("echo-view-container", "echo-revision-layout");
    const headerDiv = container.createDiv("echo-session-header");
    this.headerTitle = headerDiv.createEl("h2");
    this.headerCount = headerDiv.createEl("span", { cls: "echo-badge" });
    this.topDirective = container.createDiv("echo-top-directive");
    const mdContainerWrapper = container.createDiv("echo-markdown-wrapper");
    this.mdContainer = mdContainerWrapper.createDiv("echo-markdown-content markdown-rendered");
    this.mdContainer.addEventListener("scroll", () => {
      this.scrollPos = this.mdContainer.scrollTop;
    });
    this.bottomSection = container.createDiv("echo-bottom-section");
    this.btnBack = this.bottomSection.createEl("button", { text: "Back", cls: "echo-btn echo-btn-secondary echo-btn-nav" });
    this.btnBack.onclick = () => {
      if (this.currentStep > 1) {
        this.currentStep--;
        this.updateStepUI();
      }
    };
    this.bottomDirectiveText = this.bottomSection.createDiv("echo-bottom-directive-text");
    const rightControls = this.bottomSection.createDiv("echo-controls-right");
    this.btnNext = rightControls.createEl("button", { text: "Next", cls: "echo-btn echo-btn-nav echo-btn-active" });
    this.btnNext.onclick = () => {
      if (this.currentStep < 3) {
        this.currentStep++;
        this.updateStepUI();
      }
    };
    this.btnFinish = rightControls.createEl("button", { text: "Finish & Log", cls: "echo-btn echo-btn-primary echo-btn-nav" });
    this.btnFinish.onclick = async () => {
      await this.logAndNext();
    };
  }
  async loadCurrentNote() {
    this.currentStep = 1;
    this.scrollPos = 0;
    this.originalTexts = /* @__PURE__ */ new WeakMap();
    this.isDomWrapped = false;
    const file = this.queue[this.currentIndex];
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    this.confidence = fm?.echo_confidence || "Hard";
    this.headerTitle.textContent = `Revising: ${file.basename}`;
    this.headerCount.textContent = `Note ${this.currentIndex + 1} of ${this.queue.length}`;
    const rawText = await this.app.vault.read(file);
    const { body } = extractFrontmatter(rawText);
    this.mdContainer.empty();
    await import_obsidian.MarkdownRenderer.render(this.app, body, this.mdContainer, file.path, this);
    this.updateStepUI();
  }
  updateStepUI() {
    if (this.currentStep === 1) {
      this.topDirective.innerHTML = "<span>Firstly, <strong style='color: var(--text-error)'>say it</strong> at least a few times.</span>";
      this.bottomDirectiveText.innerHTML = "It's best to repeat this step until you know the flow of the text.";
      this.btnBack.disabled = true;
      this.btnBack.style.opacity = "0.3";
      this.btnNext.style.display = "block";
      this.btnFinish.style.display = "none";
    } else if (this.currentStep === 2) {
      this.topDirective.innerHTML = "<span>Secondly, <strong style='color: var(--text-error)'>say it without mistakes.</strong></span>";
      this.bottomDirectiveText.innerHTML = "Make sure you're comfortable with every line of the text.";
      this.btnBack.disabled = false;
      this.btnBack.style.opacity = "1";
      this.btnNext.style.display = "block";
      this.btnFinish.style.display = "none";
    } else {
      this.topDirective.innerHTML = "<span>Thirdly, <strong style='color: var(--text-error)'>say it without pausing.</strong></span>";
      this.bottomDirectiveText.innerHTML = "If you're unsure about a word, go back two steps and reread that part.";
      this.btnBack.disabled = false;
      this.btnBack.style.opacity = "1";
      this.btnNext.style.display = "none";
      this.btnFinish.style.display = "block";
      this.btnFinish.textContent = this.currentIndex < this.queue.length - 1 ? "Finish & Next Note" : "Finish & Log";
    }
    const exactScroll = this.mdContainer.scrollTop;
    this.applyMaskToDOM();
    this.mdContainer.scrollTop = exactScroll;
  }
  applyMaskToDOM() {
    if (!this.mdContainer) return;
    let targetPct = 0;
    if (this.currentStep === 2) targetPct = 30;
    if (this.currentStep === 3) targetPct = 60;
    if (this.confidence === "Moderate" && targetPct > 0) targetPct += 10;
    if (this.confidence === "Easy" && targetPct > 0) targetPct += 20;
    const ratio = targetPct / 100;
    if (!this.isDomWrapped) {
      const walker = document.createTreeWalker(this.mdContainer, NodeFilter.SHOW_TEXT, null);
      const textNodes = [];
      let n;
      while (n = walker.nextNode()) textNodes.push(n);
      for (const textNode of textNodes) {
        if (!textNode.nodeValue?.trim()) continue;
        const wrapper = document.createElement("span");
        wrapper.className = "echo-text-wrapper";
        wrapper.textContent = textNode.nodeValue;
        this.originalTexts.set(wrapper, textNode.nodeValue);
        textNode.parentNode?.replaceChild(wrapper, textNode);
      }
      this.isDomWrapped = true;
    }
    let wordIndex = 0;
    const wrappers = this.mdContainer.querySelectorAll(".echo-text-wrapper");
    wrappers.forEach((wrapper) => {
      const original = this.originalTexts.get(wrapper);
      if (original === void 0) return;
      if (targetPct === 0) {
        wrapper.textContent = original;
        return;
      }
      const el = wrapper.parentElement;
      if (!el) {
        wrapper.textContent = original;
        return;
      }
      const s = this.plugin.settings;
      if (s.skipCallouts && el.closest(".callout")) {
        wrapper.textContent = original;
        return;
      }
      if (s.skipCheckboxes && el.closest(".task-list-item")) {
        wrapper.textContent = original;
        return;
      }
      if (s.skipQuotes && el.closest("blockquote:not(.callout)")) {
        wrapper.textContent = original;
        return;
      }
      if (s.excludeInternalLinks && el.closest(".internal-link")) {
        wrapper.textContent = original;
        return;
      }
      if (s.excludeExternalLinks && el.closest(".external-link")) {
        wrapper.textContent = original;
        return;
      }
      if (s.excludeEmbeds && el.closest(".internal-embed")) {
        wrapper.textContent = original;
        return;
      }
      let processed = original;
      const placeholders = [];
      const escapedMap = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" };
      if (s.customRegex) {
        try {
          const re = new RegExp(s.customRegex, "g");
          processed = processed.replace(re, (match) => {
            let escapedMatch = match.replace(/[&<>'"]/g, (tag) => escapedMap[tag] || tag);
            placeholders.push(escapedMatch);
            return `${placeholders.length - 1}`;
          });
        } catch (e) {
        }
      }
      processed = processed.replace(/[&<>'"]/g, (match) => {
        placeholders.push(escapedMap[match] || match);
        return `${placeholders.length - 1}`;
      });
      processed = processed.replace(/(\x01\d+\x02|[\p{L}\p{N}]+)/gu, (match) => {
        if (match.startsWith("")) return match;
        wordIndex++;
        const seed = wordIndex;
        const x = Math.sin(seed) * 1e4;
        const rnd = x - Math.floor(x);
        if (rnd < ratio) {
          if (s.enableQuickLook) {
            return `<span class="echo-blank" data-word="${match}">` + "_".repeat(match.length) + `</span>`;
          } else {
            return "_".repeat(match.length);
          }
        }
        return match;
      });
      processed = processed.replace(/\x01(\d+)\x02/g, (_, idx) => {
        return placeholders[parseInt(idx, 10)];
      });
      wrapper.innerHTML = processed;
      if (s.enableQuickLook) {
        const blanks = wrapper.querySelectorAll(".echo-blank");
        blanks.forEach((b) => {
          const htmlB = b;
          htmlB.onclick = () => {
            const word = htmlB.getAttribute("data-word");
            if (word) htmlB.textContent = word;
            htmlB.classList.add("revealed");
          };
        });
      }
    });
  }
  async logAndNext() {
    const file = this.queue[this.currentIndex];
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const confidence = fm?.echo_confidence || "Hard";
    const deadline = fm?.echo_deadline;
    const history = Array.isArray(fm?.echo_history) ? fm.echo_history : [];
    history.push(getToday());
    await updateNoteFrontmatter(this.app, file, {
      echo_last_revised: getToday(),
      echo_revision_count: (fm?.echo_revision_count || 0) + 1,
      echo_next_due: calculateNextDue(confidence, deadline),
      echo_date_added: fm?.echo_date_added || getToday(),
      echo_history: history
    });
    new import_obsidian.Notice(`Logged revision for: ${file.basename}`);
    this.currentIndex++;
    if (this.currentIndex < this.queue.length) {
      await this.loadCurrentNote();
    } else {
      this.queue = [];
      this.plugin.activateDashboard();
    }
  }
};
var DashboardItemView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  plugin;
  viewMode = "all";
  sortCol = "nextDue";
  sortAsc = true;
  getViewType() {
    return ECHO_DASHBOARD_VIEW_TYPE;
  }
  getDisplayText() {
    return "Echo Recall Dashboard";
  }
  getIcon() {
    return "brain";
  }
  async onOpen() {
    this.render();
    this.registerEvent(this.app.metadataCache.on("resolved", () => {
      if (this.leaf.view === this) this.render();
    }));
  }
  getVaultData() {
    const files = this.app.metadataCache.getCachedFiles();
    const data = [];
    const today = getToday();
    for (const path of files) {
      const cache = this.app.metadataCache.getCache(path);
      if (cache?.frontmatter && cache.frontmatter.echo_date_added) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof import_obsidian.TFile) {
          const fm = cache.frontmatter;
          const archived = fm.echo_archived === true;
          const revisions = fm.echo_revision_count || 0;
          const confidence = fm.echo_confidence || "Hard";
          data.push({
            file,
            dateAdded: fm.echo_date_added,
            title: file.basename,
            tags: Array.isArray(fm.echo_tags) ? fm.echo_tags : [],
            revisions,
            lastRevised: fm.echo_last_revised || "Never",
            confidence,
            nextDue: fm.echo_next_due || getToday(),
            deadline: fm.echo_deadline || "",
            history: Array.isArray(fm.echo_history) ? fm.echo_history : [],
            archived,
            isDue: !archived && (fm.echo_next_due || getToday()) <= today,
            isLeech: !archived && revisions >= LEECH_REVISIONS && confidence === "Hard"
          });
        }
      }
    }
    return data;
  }
  render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("echo-view-container", "echo-dashboard-container");
    const fullData = this.getVaultData();
    const dueData = fullData.filter((d) => d.isDue);
    const header = container.createDiv("echo-dash-header");
    const dueBox = header.createDiv("echo-due-box");
    dueBox.createEl("div", { text: "Due Today", cls: "echo-due-label" });
    dueBox.createEl("div", { text: dueData.length.toString(), cls: "echo-due-count" });
    const masterPlay = header.createEl("button", { cls: "echo-master-play" });
    (0, import_obsidian.setIcon)(masterPlay, "play");
    masterPlay.createSpan({ text: " Start Due Notes" });
    masterPlay.onclick = () => {
      if (dueData.length === 0) return new import_obsidian.Notice("No notes due today!");
      const files = this.plugin.settings.interleaveDueQueue ? interleaveByTag(dueData) : dueData.map((d) => d.file);
      this.plugin.startRevisionSession(files);
    };
    this.renderHeatmap(container, fullData);
    let displayData = fullData;
    if (this.viewMode === "all" || this.viewMode === "tags") {
      displayData = fullData.filter((d) => !d.archived);
    } else if (this.viewMode === "archives") {
      displayData = fullData.filter((d) => d.archived);
    }
    const controls = container.createDiv("echo-dash-controls");
    controls.createEl("h3", { text: "Vault Notes" });
    const toggles = controls.createDiv("echo-toggles");
    const btnAll = toggles.createEl("button", { text: "View All", cls: `echo-btn ${this.viewMode === "all" ? "echo-btn-active" : "echo-btn-secondary"}` });
    btnAll.onclick = () => {
      this.viewMode = "all";
      this.render();
    };
    const btnTags = toggles.createEl("button", { text: "Tag-wise View", cls: `echo-btn ${this.viewMode === "tags" ? "echo-btn-active" : "echo-btn-secondary"}` });
    btnTags.onclick = () => {
      this.viewMode = "tags";
      this.render();
    };
    const btnArchives = toggles.createEl("button", { text: "Archives", cls: `echo-btn ${this.viewMode === "archives" ? "echo-btn-active" : "echo-btn-secondary"}` });
    btnArchives.onclick = () => {
      this.viewMode = "archives";
      this.render();
    };
    displayData.sort((a, b) => {
      let valA = a[this.sortCol];
      let valB = b[this.sortCol];
      if (valA < valB) return this.sortAsc ? -1 : 1;
      if (valA > valB) return this.sortAsc ? 1 : -1;
      return 0;
    });
    const tableWrapper = container.createDiv("echo-table-wrapper");
    const table = tableWrapper.createEl("table", { cls: "echo-table" });
    const thead = table.createEl("thead");
    const trHead = thead.createEl("tr");
    const headers = [
      { label: "Date Added", key: "dateAdded" },
      { label: "Note Title", key: "title" },
      { label: "Tags", key: "tags" },
      { label: "Revs", key: "revisions" },
      { label: "Last Revised", key: "lastRevised" },
      { label: "Confidence", key: "confidence" },
      { label: "Action", key: "file" },
      { label: "Deadline", key: "deadline" }
    ];
    headers.forEach((h) => {
      const th = trHead.createEl("th", { text: h.label });
      if (h.key !== "tags" && h.key !== "file") {
        th.addClass("echo-sortable");
        if (this.sortCol === h.key) th.innerHTML += this.sortAsc ? " &uarr;" : " &darr;";
        th.onclick = () => {
          if (this.sortCol === h.key) this.sortAsc = !this.sortAsc;
          else {
            this.sortCol = h.key;
            this.sortAsc = true;
          }
          this.render();
        };
      }
    });
    const tbody = table.createEl("tbody");
    if (this.viewMode === "all" || this.viewMode === "archives") {
      displayData.forEach((d) => this.renderRow(tbody, d));
    } else if (this.viewMode === "tags") {
      const grouped = { "Untagged": [] };
      displayData.forEach((d) => {
        if (d.tags.length === 0) grouped["Untagged"].push(d);
        d.tags.forEach((t) => {
          if (!grouped[t]) grouped[t] = [];
          grouped[t].push(d);
        });
      });
      Object.entries(grouped).forEach(([tag, notes]) => {
        if (notes.length === 0) return;
        const groupHead = tbody.createEl("tr", { cls: "echo-tag-header" });
        groupHead.createEl("td", { text: `#${tag}`, cls: "echo-tag-name" });
        const titleTd = groupHead.createEl("td");
        titleTd.innerHTML = `<span class="echo-badge">${notes.length} notes</span>`;
        groupHead.createEl("td");
        const totalRevs = notes.reduce((sum, n) => sum + n.revisions, 0);
        groupHead.createEl("td", { text: totalRevs.toString(), cls: "echo-td-center" });
        groupHead.createEl("td");
        const hardCount = notes.filter((n) => n.confidence === "Hard").length;
        const modCount = notes.filter((n) => n.confidence === "Moderate").length;
        const easyCount = notes.filter((n) => n.confidence === "Easy").length;
        const totalConf = hardCount + modCount + easyCount;
        const hardPct = totalConf ? Math.round(hardCount / totalConf * 100) : 0;
        const modPct = totalConf ? Math.round(modCount / totalConf * 100) : 0;
        const easyPct = totalConf ? Math.round(easyCount / totalConf * 100) : 0;
        const confTd = groupHead.createEl("td");
        confTd.innerHTML = `
                    <div class="echo-tag-conf-wrapper">
                        <div class="echo-tag-conf hard" title="Hard">${hardPct}% H</div>
                        <div class="echo-tag-conf mod" title="Moderate">${modPct}% M</div>
                        <div class="echo-tag-conf easy" title="Easy">${easyPct}% E</div>
                    </div>
                `;
        const actionTd = groupHead.createEl("td");
        const actionWrapper = actionTd.createDiv("echo-actions-cell");
        actionWrapper.style.justifyContent = "flex-start";
        const playAllBtn = actionWrapper.createEl("button", { cls: "echo-btn echo-btn-primary", attr: { "aria-label": "Revise All" } });
        playAllBtn.style.display = "flex";
        playAllBtn.style.alignItems = "center";
        playAllBtn.style.gap = "6px";
        playAllBtn.style.padding = "4px 12px";
        (0, import_obsidian.setIcon)(playAllBtn, "play");
        playAllBtn.createSpan({ text: "echo all", cls: "echo-btn-text" });
        playAllBtn.onclick = () => {
          const toRevise = notes.filter((n) => !n.archived).map((n) => n.file);
          if (toRevise.length > 0) this.plugin.startRevisionSession(toRevise);
          else new import_obsidian.Notice("No unarchived notes to revise in this tag.");
        };
        const archAllBtn = actionWrapper.createEl("button", { cls: "echo-icon-btn echo-tooltip", attr: { "aria-label": "Archive All" } });
        archAllBtn.innerText = "\u{1F393}";
        archAllBtn.style.fontSize = "0.85em";
        archAllBtn.style.padding = "4px 6px";
        archAllBtn.onclick = async () => {
          new import_obsidian.Notice(`Archiving all notes in #${tag}...`);
          for (const n of notes) {
            if (!n.archived) await updateNoteFrontmatter(this.app, n.file, { echo_archived: true });
          }
        };
        const deadlineTd = groupHead.createEl("td");
        const deadlineInput = deadlineTd.createEl("input", { type: "date", cls: "echo-deadline-input" });
        deadlineInput.title = "Apply deadline to all empty notes in this tag";
        deadlineInput.onchange = async () => {
          const val = deadlineInput.value;
          if (val) {
            new import_obsidian.Notice(`Applying deadline to empty notes in #${tag}...`);
            for (const n of notes) {
              if (!n.deadline) await updateNoteFrontmatter(this.app, n.file, { echo_deadline: val });
            }
          }
        };
        notes.forEach((d) => this.renderRow(tbody, d));
      });
    }
    const footer = container.createDiv("echo-dashboard-footer");
    footer.innerHTML = `
            <a href="https://github.com/sajee05/echo-recall" target="_blank">open source</a>, 
            feel free to star the <a href="https://github.com/sajee05/echo-recall" target="_blank">repo</a> | 
            brewed by <a href="https://www.youtube.com/@sxjeel" target="_blank">sxjeel</a> \u2615
        `;
  }
  // GitHub-style calendar of revision activity, aggregated from every note's echo_history.
  renderHeatmap(container, data) {
    const counts = /* @__PURE__ */ new Map();
    for (const d of data) {
      for (const day of d.history) counts.set(day, (counts.get(day) || 0) + 1);
    }
    if (counts.size === 0) return;
    let max = 1;
    counts.forEach((v) => {
      if (v > max) max = v;
    });
    const weeks = 26;
    const wrap = container.createDiv("echo-heatmap");
    const head = wrap.createDiv("echo-heatmap-head");
    head.createSpan({ text: "Revision activity", cls: "echo-heatmap-title" });
    const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
    head.createSpan({ text: `${total} revisions \xB7 last ${weeks} weeks`, cls: "echo-heatmap-sub" });
    const grid = wrap.createDiv("echo-heatmap-grid");
    const startWeek = window.moment().startOf("week").subtract(weeks - 1, "weeks");
    const today = window.moment();
    for (let w = 0; w < weeks; w++) {
      const col = grid.createDiv("echo-heatmap-col");
      for (let dow = 0; dow < 7; dow++) {
        const day = startWeek.clone().add(w, "weeks").add(dow, "days");
        const key = day.format("YYYY-MM-DD");
        const c = counts.get(key) || 0;
        const level = c === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(c / max * 4)));
        const cell = col.createDiv(`echo-heatmap-cell echo-hm-${level}`);
        if (day.isAfter(today, "day")) cell.addClass("echo-hm-future");
        const label = `${key}: ${c} revision${c === 1 ? "" : "s"}`;
        cell.setAttr("aria-label", label);
        cell.setAttr("title", label);
      }
    }
  }
  renderRow(tbody, data) {
    const tr = tbody.createEl("tr");
    if (data.archived) tr.style.opacity = "0.7";
    tr.createEl("td", { text: data.dateAdded, cls: "echo-td-light" });
    const tdTitle = tr.createEl("td");
    const titleLink = tdTitle.createEl("a", { text: data.title, cls: "echo-title-link" });
    titleLink.onclick = () => this.app.workspace.getLeaf("tab").openFile(data.file);
    if (data.isLeech) {
      const leech = tdTitle.createSpan({ text: "\u{1FA78} leech", cls: "echo-leech-pill" });
      leech.setAttr("aria-label", `Reviewed ${data.revisions}\xD7 but still Hard \u2014 try re-chunking or elaborating.`);
      leech.setAttr("title", `Reviewed ${data.revisions}\xD7 but still Hard \u2014 try re-chunking or elaborating.`);
    }
    const tdTags = tr.createEl("td");
    const tagsWrapper = tdTags.createDiv("echo-inline-tags");
    data.tags.forEach((tag) => {
      const tagEl = tagsWrapper.createSpan({ text: tag, cls: "echo-tag-pill" });
      const remBtn = tagEl.createSpan({ text: " \xD7", cls: "echo-tag-remove" });
      remBtn.onclick = async () => {
        await updateNoteFrontmatter(this.app, data.file, { echo_tags: data.tags.filter((t) => t !== tag) });
      };
    });
    const tagInput = tagsWrapper.createEl("input", { type: "text", placeholder: "+ tag", cls: "echo-tag-input" });
    tagInput.onkeydown = async (e) => {
      if (e.key === "Enter" && tagInput.value.trim()) {
        const newTags = [.../* @__PURE__ */ new Set([...data.tags, tagInput.value.trim()])];
        await updateNoteFrontmatter(this.app, data.file, { echo_tags: newTags });
        tagInput.value = "";
      }
    };
    tr.createEl("td", { text: data.revisions.toString(), cls: "echo-td-center" });
    tr.createEl("td", { text: data.lastRevised, cls: "echo-td-light" });
    const tdConf = tr.createEl("td");
    const select = tdConf.createEl("select", { cls: `echo-conf-select echo-conf-${data.confidence.toLowerCase()}` });
    ["Hard", "Moderate", "Easy"].forEach((opt) => {
      const option = select.createEl("option", { value: opt, text: opt });
      if (opt === data.confidence) option.selected = true;
    });
    select.onchange = async () => {
      const val = select.value;
      select.className = `echo-conf-select echo-conf-${val.toLowerCase()}`;
      await updateNoteFrontmatter(this.app, data.file, { echo_confidence: val });
    };
    const tdAction = tr.createEl("td");
    const actionWrapper = tdAction.createDiv("echo-actions-cell");
    actionWrapper.style.justifyContent = "flex-start";
    if (!data.archived) {
      const actBtn = actionWrapper.createEl("button", { cls: "echo-btn echo-btn-primary", attr: { "aria-label": "Revise Now" } });
      actBtn.style.display = "flex";
      actBtn.style.alignItems = "center";
      actBtn.style.gap = "6px";
      actBtn.style.padding = "4px 12px";
      (0, import_obsidian.setIcon)(actBtn, "play");
      actBtn.createSpan({ text: "echo", cls: "echo-btn-text" });
      actBtn.onclick = () => this.plugin.startRevisionSession([data.file]);
    }
    const archBtn = actionWrapper.createEl("button", { cls: "echo-icon-btn echo-tooltip", attr: { "aria-label": data.archived ? "Unarchive" : "Archive Note" } });
    archBtn.innerText = data.archived ? "\u{1F504}" : "\u{1F393}";
    archBtn.style.fontSize = "0.85em";
    archBtn.style.padding = "4px 6px";
    archBtn.onclick = async () => {
      await updateNoteFrontmatter(this.app, data.file, { echo_archived: !data.archived });
    };
    const tdDeadline = tr.createEl("td");
    const deadlineInput = tdDeadline.createEl("input", { type: "date", cls: "echo-deadline-input" });
    if (data.deadline) deadlineInput.value = data.deadline;
    deadlineInput.onchange = async () => {
      await updateNoteFrontmatter(this.app, data.file, { echo_deadline: deadlineInput.value });
    };
  }
};
var EchoRecallPlugin = class extends import_obsidian.Plugin {
  settings;
  async onload() {
    await this.loadSettings();
    this.injectCSS();
    this.addSettingTab(new EchoRecallSettingsTab(this.app, this));
    this.registerView(ECHO_DASHBOARD_VIEW_TYPE, (leaf) => new DashboardItemView(leaf, this));
    this.registerView(ECHO_REVISION_VIEW_TYPE, (leaf) => new RevisionItemView(leaf, this));
    this.addRibbonIcon("brain", "Echo Recall Dashboard", () => {
      this.activateDashboard();
    });
    this.app.workspace.onLayoutReady(() => this.injectHeaderButtons());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.injectHeaderButtons()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.injectHeaderButtons()));
    this.addCommand({
      id: "echo-recall-start-active",
      name: "Revise active note",
      checkCallback: (checking) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
          if (!checking) this.initializeSingleNoteRevision(activeFile);
          return true;
        }
        return false;
      }
    });
    this.addCommand({
      id: "echo-recall-open-dashboard",
      name: "Open Dashboard",
      callback: () => this.activateDashboard()
    });
  }
  injectHeaderButtons() {
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    leaves.forEach((leaf) => {
      const view = leaf.view;
      if (!view || !view.containerEl) return;
      const actions = view.containerEl.querySelector(".view-actions");
      if (actions && !actions.querySelector(".echo-header-btn")) {
        const btn = document.createElement("div");
        btn.className = "clickable-icon view-action echo-header-btn";
        btn.setAttribute("aria-label", "Revise with Echo Recall");
        (0, import_obsidian.setIcon)(btn, "play");
        const span = btn.createSpan({ text: " echo" });
        span.style.marginLeft = "4px";
        span.style.fontWeight = "bold";
        span.style.fontSize = "0.95em";
        btn.style.width = "auto";
        btn.style.padding = "0 10px";
        btn.style.display = "flex";
        btn.style.alignItems = "center";
        btn.onclick = () => {
          const activeFile = view.file || this.app.workspace.getActiveFile();
          if (activeFile) this.initializeSingleNoteRevision(activeFile);
        };
        actions.insertBefore(btn, actions.firstChild);
      }
    });
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  async activateDashboard() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(ECHO_DASHBOARD_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: ECHO_DASHBOARD_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
  async startRevisionSession(files) {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(ECHO_REVISION_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: ECHO_REVISION_VIEW_TYPE, active: true });
    }
    const view = leaf.view;
    await view.startSession(files);
  }
  async initializeSingleNoteRevision(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache?.frontmatter?.echo_date_added) {
      await updateNoteFrontmatter(this.app, file, { echo_date_added: getToday(), echo_confidence: "Hard" });
    }
    this.startRevisionSession([file]);
  }
  injectCSS() {
    const css = `
        .echo-view-container { padding: 20px; font-family: var(--font-interface); max-width: 1100px; width: 100%; margin: 0 auto; box-sizing: border-box; }
        .echo-badge { background: var(--background-modifier-hover); padding: 4px 10px; border-radius: 12px; font-size: 0.8em; font-weight: 500; white-space: nowrap; display: inline-block;}
        
        .echo-revision-layout { display: flex; flex-direction: column; height: 100%; }
        .echo-session-header { flex-shrink: 0; display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
        .echo-session-header h2 { margin: 0; font-size: 1.4em; }

        .echo-top-directive { flex-shrink: 0; text-align: center; padding: 16px; border-radius: 12px; background-color: var(--background-secondary); border: 1px solid var(--background-modifier-border); font-size: 1.05em; color: var(--text-normal); margin-bottom: 15px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); min-height: 80px; display: flex; flex-direction: column; justify-content: center; align-items: center; box-sizing: border-box; }

        .echo-markdown-wrapper { flex-grow: 1; overflow: hidden; display: flex; flex-direction: column; border-radius: 12px; background: var(--background-primary); border: 1px solid var(--background-modifier-border); box-shadow: inset 0px 4px 12px rgba(0,0,0,0.03); position: relative; }
        .echo-markdown-content { flex-grow: 1; overflow-y: auto; padding: 30px; font-size: 1.05em; line-height: 1.6; color: var(--text-normal); }
        .echo-markdown-content p:first-child { margin-top: 0; }
        
        .echo-bottom-section { flex-shrink: 0; margin-top: 15px; display: flex; justify-content: space-between; align-items: center; background-color: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 12px; padding: 12px 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
        .echo-bottom-directive-text { font-size: 1.05em; color: var(--text-muted); text-align: center; flex-grow: 1; padding: 0 15px; min-height: 2.5em; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }
        .echo-controls-right { display: flex; align-items: center; }

        .echo-btn-nav { min-width: 90px; padding: 10px 16px; font-weight: 600; }
        .echo-btn { padding: 8px 16px; border-radius: 8px; border: none; cursor: pointer; font-weight: 500; transition: background 0.2s, opacity 0.2s; background: transparent; color: var(--text-muted); }
        .echo-btn-active { background: var(--background-primary); color: var(--text-normal); box-shadow: 0 2px 4px rgba(0,0,0,0.05); border: 1px solid var(--background-modifier-border); }
        .echo-btn-primary { background: var(--interactive-accent); color: var(--text-on-accent); border: 1px solid transparent; }
        .echo-btn-secondary { background: var(--background-modifier-hover); color: var(--text-normal); }

        .echo-header-btn { color: var(--text-muted); transition: color 0.2s, background-color 0.2s; }
        .echo-header-btn:hover { color: var(--text-normal); background-color: var(--background-modifier-hover); }

        .echo-dash-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; padding: 20px; background: var(--background-secondary); border-radius: 16px; border: 1px solid var(--background-modifier-border); }
        .echo-due-box { display: flex; flex-direction: column; }
        .echo-due-label { font-size: 0.9em; text-transform: uppercase; letter-spacing: 1px; color: var(--text-muted); }
        .echo-due-count { font-size: 3.5em; font-weight: 700; line-height: 1; color: var(--text-normal); }
        .echo-master-play { background: var(--interactive-accent); color: var(--text-on-accent); border: none; padding: 12px 24px; border-radius: 20px; font-size: 1.1em; cursor: pointer; display: flex; align-items: center; gap: 8px; font-weight: 600; box-shadow: 0 4px 12px rgba(0,0,0,0.1); transition: opacity 0.2s; }
        .echo-master-play:hover { opacity: 0.9; }

        .echo-dash-controls { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        .echo-toggles { display: flex; gap: 10px; background: var(--background-secondary); padding: 4px; border-radius: 10px; }
        
        .echo-table-wrapper { overflow-x: auto; background: var(--background-primary); border-radius: 12px; border: 1px solid var(--background-modifier-border); }
        .echo-table { width: 100%; border-collapse: collapse; text-align: left; }
        .echo-table th { padding: 16px; font-size: 0.9em; text-transform: uppercase; color: var(--text-muted); border-bottom: 2px solid var(--background-modifier-border); position: sticky; top: 0; background: var(--background-primary); z-index: 2; }
        .echo-sortable { cursor: pointer; transition: color 0.2s; }
        .echo-sortable:hover { color: var(--text-normal); }
        .echo-table td { padding: 14px 16px; border-bottom: 1px solid var(--background-modifier-border); vertical-align: middle; }
        .echo-table tr:last-child td { border-bottom: none; }
        
        .echo-tag-header { background: var(--background-secondary-alt); border-top: 2px solid var(--background-modifier-border); }
        .echo-tag-name { font-weight: bold; color: var(--text-accent); font-size: 1.05em; white-space: nowrap; }

        .echo-title-link { cursor: pointer; font-weight: 500; color: var(--text-accent); text-decoration: none; display: block; line-height: 1.4;}
        .echo-title-link:hover { text-decoration: underline; }
        .echo-td-light { color: var(--text-muted); font-size: 0.9em; white-space: nowrap; }
        .echo-td-center { text-align: center; }
        
        .echo-actions-cell { display: flex; gap: 6px; justify-content: center; align-items: center; height: 100%; white-space: nowrap; }
        
        .echo-inline-tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
        .echo-tag-pill { background: var(--background-secondary-alt); border: 1px solid var(--background-modifier-border); padding: 2px 8px; border-radius: 12px; font-size: 0.85em; display: flex; align-items: center; gap: 4px; }
        .echo-tag-remove { cursor: pointer; color: var(--text-faint); font-weight: bold; padding: 0 2px; }
        .echo-tag-remove:hover { color: var(--text-error); }
        .echo-tag-input { border: none; background: transparent; padding: 2px 6px; font-size: 0.85em; width: 60px; outline: none; border-radius: 8px; }
        .echo-tag-input:focus { background: var(--background-secondary); }
        
        .echo-deadline-input { border: 1px solid transparent; background: transparent; color: var(--text-normal); font-family: var(--font-interface); padding: 4px; font-size: 0.9em; border-radius: 6px; cursor: pointer; transition: background 0.2s, border 0.2s; white-space: nowrap; }
        .echo-deadline-input:hover, .echo-deadline-input:focus { border: 1px solid var(--background-modifier-border); background: var(--background-secondary); }

        .echo-conf-select { border: none; border-radius: 8px; padding: 4px 8px; font-size: 0.9em; cursor: pointer; font-weight: 500; }
        .echo-conf-hard { background: rgba(223, 76, 76, 0.1); color: #df4c4c; }
        .echo-conf-moderate { background: rgba(219, 153, 40, 0.1); color: #db9928; }
        .echo-conf-easy { background: rgba(67, 181, 105, 0.1); color: #43b569; }
        
        .echo-icon-btn { background: transparent; border: none; cursor: pointer; color: var(--text-muted); padding: 6px; border-radius: 6px; transition: background 0.2s, color 0.2s; display: flex; align-items: center; justify-content: center; }
        .echo-icon-btn:hover { background: var(--interactive-accent); color: var(--text-on-accent); }
        
        .echo-dashboard-footer, .echo-settings-footer { text-align: center; margin-top: 40px; padding-top: 20px; font-size: 0.85em; color: var(--text-muted); border-top: 1px solid var(--background-modifier-border); }
        .echo-dashboard-footer a, .echo-settings-footer a { color: var(--text-muted); text-decoration: underline; text-underline-offset: 2px; }
        .echo-dashboard-footer a:hover, .echo-settings-footer a:hover { color: var(--text-normal); }

        .echo-tag-conf-wrapper { display: flex; flex-direction: column; gap: 3px; font-size: 0.85em; font-weight: 600; width: max-content; align-items: center; }
        .echo-tag-conf { border-radius: 4px; padding: 2px 6px; text-align: center; width: 60px; box-sizing: border-box; }
        .echo-tag-conf.hard { background: rgba(223, 76, 76, 0.1); color: #df4c4c; }
        .echo-tag-conf.mod { background: rgba(219, 153, 40, 0.1); color: #db9928; }
        .echo-tag-conf.easy { background: rgba(67, 181, 105, 0.1); color: #43b569; }

        .echo-blank { cursor: pointer; transition: color 0.2s; }
        .echo-blank:hover { color: var(--text-muted); }
        .echo-blank.revealed { color: var(--text-error); cursor: default; }

        .echo-leech-pill { margin-left: 8px; font-size: 0.75em; font-weight: 600; color: #df4c4c; background: rgba(223, 76, 76, 0.12); border-radius: 10px; padding: 1px 7px; white-space: nowrap; cursor: help; }

        .echo-heatmap { margin-bottom: 25px; padding: 16px 20px; background: var(--background-secondary); border-radius: 16px; border: 1px solid var(--background-modifier-border); }
        .echo-heatmap-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; flex-wrap: wrap; gap: 6px; }
        .echo-heatmap-title { font-size: 0.9em; text-transform: uppercase; letter-spacing: 1px; color: var(--text-muted); }
        .echo-heatmap-sub { font-size: 0.8em; color: var(--text-faint); }
        .echo-heatmap-grid { display: flex; gap: 3px; overflow-x: auto; }
        .echo-heatmap-col { display: flex; flex-direction: column; gap: 3px; }
        .echo-heatmap-cell { width: 12px; height: 12px; border-radius: 3px; background: var(--background-modifier-border); }
        .echo-hm-0 { background: var(--background-modifier-border); }
        .echo-hm-1 { background: rgba(67, 181, 105, 0.35); }
        .echo-hm-2 { background: rgba(67, 181, 105, 0.55); }
        .echo-hm-3 { background: rgba(67, 181, 105, 0.75); }
        .echo-hm-4 { background: rgba(67, 181, 105, 1); }
        .echo-hm-future { opacity: 0.25; }

        @media (max-width: 600px) {
            .echo-view-container { padding: 10px; position: relative; }
            .echo-dash-header { flex-direction: column; gap: 15px; align-items: flex-start; }
            .echo-table-wrapper { font-size: 0.9em; }
            
            .echo-session-header { margin-bottom: 8px; }
            .echo-session-header h2 { font-size: 1.1em; }
            .echo-top-directive { padding: 8px; min-height: auto; margin-bottom: 10px; font-size: 0.95em; }
            
            /* Give extra scroll room so the last line doesn't hide behind floating buttons */
            .echo-markdown-content { padding: 15px; padding-bottom: 110px; font-size: 1em; }
            
            /* Floating Invisible Bottom Bar */
            .echo-bottom-section {
                position: absolute;
                bottom: calc(75px + env(safe-area-inset-bottom, 20px));
                left: 15px;
                right: 15px;
                flex-direction: row;
                padding: 0;
                margin: 0;
                background: transparent !important;
                border: none !important;
                box-shadow: none !important;
                pointer-events: none; /* Lets you click text in the empty space between buttons */
                justify-content: space-between;
                z-index: 100;
            }
            .echo-bottom-directive-text { display: none; }
            .echo-controls-right { display: flex; }
            
            /* Modern Hovering Pill Styling */
            .echo-btn-nav {
                pointer-events: auto; /* Makes the buttons clickable again */
                padding: 12px 24px;
                font-size: 0.95em;
                border-radius: 30px;
                box-shadow: 0 4px 15px rgba(0,0,0,0.35) !important;
                min-width: auto;
                font-weight: 600;
            }
            /* Opaque backgrounds for the floating buttons */
            .echo-btn-secondary.echo-btn-nav, .echo-btn-active.echo-btn-nav {
                background: var(--background-primary) !important;
                border: 1px solid var(--background-modifier-border) !important;
                color: var(--text-normal) !important;
            }
            .echo-btn-primary.echo-btn-nav {
                background: var(--interactive-accent) !important;
                color: var(--text-on-accent) !important;
            }
        }
        `;
    const style = document.createElement("style");
    style.id = "echo-recall-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }
  onunload() {
    document.getElementById("echo-recall-styles")?.remove();
  }
};
var EchoRecallSettingsTab = class extends import_obsidian.PluginSettingTab {
  plugin;
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Echo Recall Settings" });
    containerEl.createEl("p", { text: "Configure which elements should be bypassed by the text masking engine.", cls: "setting-item-description" });
    containerEl.createEl("br");
    new import_obsidian.Setting(containerEl).setName("Interleave due notes").setDesc("When starting your due notes, mix them across their echo tags so consecutive notes cover different topics (interleaving improves retention over blocked practice).").addToggle((toggle) => toggle.setValue(this.plugin.settings.interleaveDueQueue).onChange(async (val) => {
      this.plugin.settings.interleaveDueQueue = val;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Enable Quick-Look and Cheating Mode").setDesc("Allows clicking on a blank to reveal the word (turns red to indicate a cheat)").addToggle((toggle) => toggle.setValue(this.plugin.settings.enableQuickLook).onChange(async (val) => {
      this.plugin.settings.enableQuickLook = val;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Don't revise callouts").setDesc("Skips all text located inside Obsidian callouts").addToggle((toggle) => toggle.setValue(this.plugin.settings.skipCallouts).onChange(async (val) => {
      this.plugin.settings.skipCallouts = val;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Don't revise checkboxes").setDesc("Skips all text inside task/checkbox lines").addToggle((toggle) => toggle.setValue(this.plugin.settings.skipCheckboxes).onChange(async (val) => {
      this.plugin.settings.skipCheckboxes = val;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Don't revise quotes").setDesc("Skips standard blockquotes").addToggle((toggle) => toggle.setValue(this.plugin.settings.skipQuotes).onChange(async (val) => {
      this.plugin.settings.skipQuotes = val;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Exclude internal links").setDesc("Prevents masking text inside [[wikilinks]]").addToggle((toggle) => toggle.setValue(this.plugin.settings.excludeInternalLinks).onChange(async (val) => {
      this.plugin.settings.excludeInternalLinks = val;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Exclude external links").setDesc("Prevents masking text inside [links](urls)").addToggle((toggle) => toggle.setValue(this.plugin.settings.excludeExternalLinks).onChange(async (val) => {
      this.plugin.settings.excludeExternalLinks = val;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Exclude Attachments and embeds").setDesc("Prevents masking embedded files ![[]]").addToggle((toggle) => toggle.setValue(this.plugin.settings.excludeEmbeds).onChange(async (val) => {
      this.plugin.settings.excludeEmbeds = val;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Don't revise custom regex").setDesc("Provide a custom regex string to bypass masking (e.g., \\^\\d+ to skip footnotes)").addText((text) => text.setPlaceholder("Enter regex...").setValue(this.plugin.settings.customRegex).onChange(async (val) => {
      this.plugin.settings.customRegex = val;
      await this.plugin.saveSettings();
    }));
    const footer = containerEl.createDiv("echo-settings-footer");
    footer.innerHTML = `
            <a href="https://github.com/sajee05/echo-recall" target="_blank">open source</a>, 
            feel free to star the <a href="https://github.com/sajee05/echo-recall" target="_blank">repo</a> | 
            brewed by <a href="https://www.youtube.com/@sxjeel" target="_blank">sxjeel</a> \u2615
        `;
  }
};
