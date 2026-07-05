import {
    App, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, Notice,
    TFile, MarkdownRenderer, setIcon, MarkdownView, Modal
} from 'obsidian';

const ECHO_DASHBOARD_VIEW_TYPE = 'echo-dashboard-view';
const ECHO_REVISION_VIEW_TYPE = 'echo-revision-view';

interface EchoRecallSettings {
    skipCallouts: boolean;
    skipCheckboxes: boolean;
    skipQuotes: boolean;
    excludeInternalLinks: boolean;
    excludeExternalLinks: boolean;
    excludeEmbeds: boolean;
    customRegex: string;
    enableQuickLook: boolean;
    schedulingMode: 'confidence' | 'sm2';
    cueMode: 'blank' | 'first-letter' | 'graduated';
    enableTypedRecall: boolean;
    chunkMode: 'off' | 'paragraph' | 'sentence';
    interleaveDueQueue: boolean;
    sm2SimplifyGrades: boolean; // Feature 5: Simplify grades
}

const DEFAULT_SETTINGS: EchoRecallSettings = {
    skipCallouts: true,
    skipCheckboxes: true,
    skipQuotes: false,
    excludeInternalLinks: true,
    excludeExternalLinks: true,
    excludeEmbeds: true,
    customRegex: '',
    enableQuickLook: true,
    schedulingMode: 'confidence',
    cueMode: 'blank',
    enableTypedRecall: false,
    chunkMode: 'off',
    interleaveDueQueue: false,
    sm2SimplifyGrades: false
};

const LEECH_REVISIONS = 8;

interface EchoFrontmatter {
    echo_date_added?: string;
    echo_last_revised?: string;
    echo_revision_count?: number;
    echo_confidence?: 'Hard' | 'Moderate' | 'Easy';
    echo_next_due?: string;
    echo_tags?: string[];
    echo_deadline?: string;
    echo_history?: string[];
    echo_archived?: boolean;
    echo_ease?: number;      
    echo_interval?: number;  
    echo_reps?: number;      
    echo_past_grades?: string[]; // Feature 4: Store history
}

interface DashboardNoteData {
    file: TFile;
    dateAdded: string;
    title: string;
    tags: string[];
    revisions: number;
    lastRevised: string;
    confidence: 'Hard' | 'Moderate' | 'Easy';
    nextDue: string;
    isDue: boolean;
    deadline: string;
    history: string[];
    archived: boolean;
    isLeech: boolean;
    pastGrades: string[];
}

function interleaveByTag(data: DashboardNoteData[]): TFile[] {
    const groups = new Map<string, TFile[]>();
    for (const d of data) {
        const key = d.tags.length ? d.tags[0] : '__untagged__';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(d.file);
    }
    const lists = Array.from(groups.values());
    const out: TFile[] = [];
    for (let i = 0, added = true; added; i++) {
        added = false;
        for (const list of lists) {
            if (i < list.length) { out.push(list[i]); added = true; }
        }
    }
    return out;
}

function getToday(): string {
    return window.moment().format('YYYY-MM-DD');
}

function deadlineCap(days: number, deadlineStr?: string): number {
    if (!deadlineStr) return days;
    const daysRemaining = window.moment(deadlineStr, 'YYYY-MM-DD').diff(window.moment(), 'days');
    if (daysRemaining > 0 && daysRemaining < days) {
        return Math.max(1, Math.floor(daysRemaining * 0.5));
    }
    return days;
}

function calculateNextDue(confidence: string, deadlineStr?: string): string {
    let days = 1;
    if (confidence === 'Moderate') days = 7;
    if (confidence === 'Easy') days = 14;
    if (confidence !== 'Easy') days = deadlineCap(days, deadlineStr);
    return window.moment().add(days, 'days').format('YYYY-MM-DD');
}

type EchoGrade = 'Again' | 'Hard' | 'Good' | 'Easy';
const SM2_QUALITY: Record<EchoGrade, number> = { Again: 1, Hard: 3, Good: 4, Easy: 5 };

interface Sm2State { ease: number; interval: number; reps: number; }

function sm2(state: Sm2State, quality: number): Sm2State {
    let { ease, interval, reps } = state;
    if (quality < 3) {
        reps = 0;
        interval = 1;
    } else {
        reps += 1;
        interval = reps === 1 ? 1 : (reps === 2 ? 6 : Math.round(interval * ease));
    }
    ease = Math.max(1.3, ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
    ease = Math.round(ease * 100) / 100;
    return { ease, interval, reps };
}

function confidenceFromEase(ease: number): 'Hard' | 'Moderate' | 'Easy' {
    if (ease >= 2.6) return 'Easy';
    if (ease >= 2.2) return 'Moderate';
    return 'Hard';
}

function seedEaseFromConfidence(confidence?: string): number {
    if (confidence === 'Hard') return 2.3;
    if (confidence === 'Easy') return 2.7;
    return 2.5;
}

async function updateNoteFrontmatter(app: App, file: TFile, updates: Partial<EchoFrontmatter>) {
    await app.fileManager.processFrontMatter(file, (fm) => {
        if (updates.echo_date_added !== undefined) fm['echo_date_added'] = updates.echo_date_added;
        if (updates.echo_last_revised !== undefined) fm['echo_last_revised'] = updates.echo_last_revised;
        if (updates.echo_revision_count !== undefined) fm['echo_revision_count'] = updates.echo_revision_count;
        if (updates.echo_confidence !== undefined) fm['echo_confidence'] = updates.echo_confidence;
        if (updates.echo_next_due !== undefined) fm['echo_next_due'] = updates.echo_next_due;
        if (updates.echo_tags !== undefined) fm['echo_tags'] = updates.echo_tags;
        if (updates.echo_deadline !== undefined) fm['echo_deadline'] = updates.echo_deadline;
        if (updates.echo_history !== undefined) fm['echo_history'] = updates.echo_history;
        if (updates.echo_archived !== undefined) fm['echo_archived'] = updates.echo_archived;
        if (updates.echo_ease !== undefined) fm['echo_ease'] = updates.echo_ease;
        if (updates.echo_interval !== undefined) fm['echo_interval'] = updates.echo_interval;
        if (updates.echo_reps !== undefined) fm['echo_reps'] = updates.echo_reps;
        if (updates.echo_past_grades !== undefined) fm['echo_past_grades'] = updates.echo_past_grades;
    });
}

function extractFrontmatter(text: string): { frontmatter: string, body: string } {
    const match = text.match(/^---\n[\s\S]*?\n---\n/);
    if (match) {
        return { frontmatter: match[0], body: text.slice(match[0].length) };
    }
    return { frontmatter: '', body: text };
}

type CueKind = 'blank' | 'first-letter';

function cueForStep(mode: 'blank' | 'first-letter' | 'graduated', step: number): CueKind {
    if (mode === 'first-letter') return 'first-letter';
    if (mode === 'graduated') return step >= 3 ? 'blank' : 'first-letter';
    return 'blank';
}

function maskWord(word: string, cue: CueKind): string {
    if (cue === 'first-letter' && word.length > 1) {
        return word[0] + '_'.repeat(word.length - 1);
    }
    return '_'.repeat(word.length);
}

function normalizeWords(text: string): string[] {
    return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

function scoreRecall(reference: string, typed: string):
    { correct: number; total: number; refWords: string[]; matchedRef: boolean[] } {
    const refWords = normalizeWords(reference);
    const typedWords = normalizeWords(typed);
    const n = refWords.length;
    const m = typedWords.length;
    const matchedRef = new Array(n).fill(false);
    if (n === 0 || m === 0 || n * m > 4_000_000) {
        return { correct: 0, total: n, refWords, matchedRef };
    }
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            dp[i][j] = refWords[i - 1] === typedWords[j - 1]
                ? dp[i - 1][j - 1] + 1
                : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    let i = n, j = m;
    while (i > 0 && j > 0) {
        if (refWords[i - 1] === typedWords[j - 1]) { matchedRef[i - 1] = true; i--; j--; }
        else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
        else j--;
    }
    return { correct: dp[n][m], total: n, refWords, matchedRef };
}

// Feature 1: Context-Aware Paragraph Chunking
function splitChunks(body: string, mode: 'paragraph' | 'sentence'): string[] {
    const text = body.trim();
    if (!text) return [body];
    
    if (mode === 'sentence') {
        const parts = text.split(/(?<=[.!?]["'”’)\]]?)\s+(?=["'“‘([]?[A-Z0-9])/);
        const chunks = parts.map(s => s.trim()).filter(Boolean);
        return chunks.length ? chunks : [body];
    }
    
    // Paragraph mode with context preservation
    const rawParagraphs = text.split(/\n\s*\n+/);
    const chunks: string[] = [];
    const currentHeadings: { level: number, text: string }[] = [];

    for (let i = 0; i < rawParagraphs.length; i++) {
        const p = rawParagraphs[i].trim();
        if (!p) continue;

        const lines = p.split('\n');
        let allHeadings = true;
        for (const line of lines) {
            if (!line.match(/^#{1,6}\s/)) {
                allHeadings = false;
                break;
            }
        }

        for (const line of lines) {
            const m = line.match(/^(#{1,6})\s+(.*)/);
            if (m) {
                const level = m[1].length;
                while (currentHeadings.length > 0 && currentHeadings[currentHeadings.length - 1].level >= level) {
                    currentHeadings.pop();
                }
                currentHeadings.push({ level, text: line });
            }
        }

        if (allHeadings) continue;

        let contextStr = "";
        for (const h of currentHeadings) {
            if (!p.includes(h.text)) contextStr += h.text + "\n\n";
        }
        chunks.push((contextStr + p).trim());
    }
    return chunks.length ? chunks : [body];
}

class RevisionItemView extends ItemView {
    queue: TFile[] = [];
    currentIndex: number = 0;
    currentStep: 1 | 2 | 3 = 1;
    scrollPos: number = 0;
    
    confidence: string = 'Hard';
    originalTexts: WeakMap<HTMLElement | Text, string> = new WeakMap();
    isDomWrapped: boolean = false;

    chunks: string[] = [];       
    currentChunk: number = 0;
    originalFullBody: string = "";
    file: TFile;

    headerTitle: HTMLElement;
    headerCount: HTMLElement;
    peekBtn: HTMLElement; // Feature 2
    topDirective: HTMLElement;
    mdContainer: HTMLElement;
    bottomSection: HTMLElement;
    bottomDirectiveText: HTMLElement;
    btnBack: HTMLButtonElement;
    btnNext: HTMLButtonElement;
    btnFinish: HTMLButtonElement;
    gradeBar: HTMLElement;   
    btnType: HTMLButtonElement;      
    typePanel: HTMLElement;          
    typeInput: HTMLTextAreaElement;
    typeResult: HTMLElement;

    constructor(leaf: WorkspaceLeaf, public plugin: EchoRecallPlugin) {
        super(leaf);
    }

    getViewType(): string { return ECHO_REVISION_VIEW_TYPE; }
    getDisplayText(): string { return "Echo Recall Session"; }
    getIcon(): string { return "brain-circuit"; }

    async startSession(files: TFile[]) {
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
        container.addClass('echo-view-container', 'echo-revision-layout');

        const headerDiv = container.createDiv('echo-session-header');
        this.headerTitle = headerDiv.createEl('h2');
        this.headerCount = headerDiv.createEl('span', { cls: 'echo-badge' });

        this.peekBtn = headerDiv.createEl('button', { cls: 'echo-icon-btn echo-peek-btn echo-tooltip', attr: { 'aria-label': 'Peek full note' } });
        setIcon(this.peekBtn, 'eye');
        this.peekBtn.onclick = () => this.showPeekModal();

        this.topDirective = container.createDiv('echo-top-directive');

        const mdContainerWrapper = container.createDiv('echo-markdown-wrapper');
        this.mdContainer = mdContainerWrapper.createDiv('echo-markdown-content markdown-rendered');
        
        this.mdContainer.addEventListener('scroll', () => {
            this.scrollPos = this.mdContainer.scrollTop;
        });

        this.typePanel = container.createDiv('echo-type-panel');
        this.typeInput = this.typePanel.createEl('textarea', {
            cls: 'echo-type-input',
            attr: { placeholder: 'Type the passage from memory, then press Check…' }
        });
        const typeBar = this.typePanel.createDiv('echo-type-bar');
        const checkBtn = typeBar.createEl('button', { text: 'Check', cls: 'echo-btn echo-btn-primary' });
        checkBtn.onclick = () => this.checkTyped();
        const clearBtn = typeBar.createEl('button', { text: 'Clear', cls: 'echo-btn echo-btn-secondary' });
        clearBtn.onclick = () => { this.typeInput.value = ''; this.typeResult.empty(); this.typeInput.focus(); };
        this.typeResult = this.typePanel.createDiv('echo-type-result');
        this.typePanel.style.display = 'none';

        this.bottomSection = container.createDiv('echo-bottom-section');
        
        this.btnBack = this.bottomSection.createEl('button', { text: 'Back', cls: 'echo-btn echo-btn-secondary echo-btn-nav' });
        this.btnBack.onclick = () => {
            if (this.currentStep > 1) { this.currentStep--; this.updateStepUI(); }
        };

        this.bottomDirectiveText = this.bottomSection.createDiv('echo-bottom-directive-text');

        const rightControls = this.bottomSection.createDiv('echo-controls-right');

        this.btnType = rightControls.createEl('button', { text: '⌨ Type', cls: 'echo-btn echo-btn-nav echo-btn-secondary' });
        this.btnType.onclick = () => this.toggleTypePanel();

        this.btnNext = rightControls.createEl('button', { text: 'Next', cls: 'echo-btn echo-btn-nav echo-btn-active' });
        this.btnNext.onclick = () => { 
            if (this.currentStep < 3) { this.currentStep++; this.updateStepUI(); }
        };

        this.btnFinish = rightControls.createEl('button', { text: 'Finish & Log', cls: 'echo-btn echo-btn-primary echo-btn-nav' });
        this.btnFinish.onclick = async () => { await this.advanceOrFinish(); };

        this.gradeBar = rightControls.createDiv('echo-grade-bar');
        this.gradeBar.style.display = 'none';
    }

    async loadCurrentNote() {
        this.file = this.queue[this.currentIndex];
        const fm = this.app.metadataCache.getFileCache(this.file)?.frontmatter;
        this.confidence = fm?.echo_confidence || 'Hard';

        this.headerTitle.textContent = `Revising: ${this.file.basename}`;

        const rawText = await this.app.vault.read(this.file);
        const { body } = extractFrontmatter(rawText);
        this.originalFullBody = body;

        const mode = this.plugin.settings.chunkMode;
        this.chunks = mode === 'off' ? [body] : splitChunks(body, mode);
        this.currentChunk = 0;

        await this.renderCurrentChunk();
    }

    async renderCurrentChunk() {
        this.currentStep = 1;
        this.scrollPos = 0;
        this.originalTexts = new WeakMap();
        this.isDomWrapped = false;

        this.typePanel.style.display = 'none';
        this.btnType.removeClass('echo-btn-active');
        this.typeInput.value = '';
        this.typeResult.empty();

        const total = this.chunks.length;
        this.headerCount.textContent = total > 1
            ? `Note ${this.currentIndex + 1}/${this.queue.length} · chunk ${this.currentChunk + 1}/${total}`
            : `Note ${this.currentIndex + 1} of ${this.queue.length}`;

        this.mdContainer.empty();
        await MarkdownRenderer.render(this.app, this.chunks[this.currentChunk], this.mdContainer, this.file.path, this);

        this.updateStepUI();
    }

    async advanceOrFinish() {
        if (this.currentChunk < this.chunks.length - 1) {
            this.currentChunk++;
            await this.renderCurrentChunk();
        } else {
            await this.logAndNext();
        }
    }

    showPeekModal() {
        const modal = new Modal(this.app);
        modal.titleEl.setText('Peek: ' + this.file.basename);
        modal.contentEl.addClass('echo-markdown-content', 'markdown-rendered');
        modal.contentEl.style.padding = '30px';
        MarkdownRenderer.render(this.app, this.originalFullBody, modal.contentEl, this.file.path, this);
        modal.open();
    }

    updateStepUI() {
        const sm2Mode = this.plugin.settings.schedulingMode === 'sm2';
        
        this.peekBtn.style.display = this.currentStep === 3 ? 'none' : 'flex';

        if (this.currentStep === 1) {
            this.topDirective.innerHTML = "<span>Firstly, <strong style='color: var(--text-error)'>say it</strong> at least a few times.</span>";
            this.bottomDirectiveText.innerHTML = "It's best to repeat this step until you know the flow of the text.";
            this.btnBack.disabled = true;
            this.btnBack.style.opacity = '0.3';
            this.btnNext.style.display = 'block';
            this.btnFinish.style.display = 'none';
            this.gradeBar.style.display = 'none';
        } else if (this.currentStep === 2) {
            this.topDirective.innerHTML = "<span>Secondly, <strong style='color: var(--text-error)'>say it without mistakes.</strong></span>";
            this.bottomDirectiveText.innerHTML = "Make sure you're comfortable with every line of the text.";
            this.btnBack.disabled = false;
            this.btnBack.style.opacity = '1';
            this.btnNext.style.display = 'block';
            this.btnFinish.style.display = 'none';
            this.gradeBar.style.display = 'none';
        } else {
            this.topDirective.innerHTML = "<span>Thirdly, <strong style='color: var(--text-error)'>say it without pausing.</strong></span>";
            this.btnBack.disabled = false;
            this.btnBack.style.opacity = '1';
            this.btnNext.style.display = 'none';
            const isLastChunk = this.currentChunk >= this.chunks.length - 1;
            
            if (!isLastChunk) {
                this.bottomDirectiveText.innerHTML = "If you're unsure about a word, go back two steps and reread that part.";
                this.btnFinish.style.display = 'block';
                this.btnFinish.textContent = "Next chunk";
                this.gradeBar.style.display = 'none';
            } else if (sm2Mode) {
                this.bottomDirectiveText.innerHTML = "How did that go? Grade your recall to schedule the next review.";
                this.btnFinish.style.display = 'none';
                this.gradeBar.style.display = 'flex';
                
                // Feature 5: Update Grades
                this.gradeBar.empty();
                const grades: EchoGrade[] = this.plugin.settings.sm2SimplifyGrades ? ['Again', 'Good'] : ['Again', 'Hard', 'Good', 'Easy'];
                grades.forEach(g => {
                    const b = this.gradeBar.createEl('button', {
                        text: g,
                        cls: `echo-btn echo-btn-nav echo-grade echo-grade-${g.toLowerCase()}`
                    });
                    b.onclick = async () => { await this.logAndNext(SM2_QUALITY[g]); };
                });

            } else {
                this.bottomDirectiveText.innerHTML = "If you're unsure about a word, go back two steps and reread that part.";
                this.btnFinish.style.display = 'block';
                this.gradeBar.style.display = 'none';
                this.btnFinish.textContent = (this.currentIndex < this.queue.length - 1) ? "Finish & Next Note" : "Finish & Log";
            }
        }

        this.btnType.style.display = this.plugin.settings.enableTypedRecall ? 'block' : 'none';

        const exactScroll = this.mdContainer.scrollTop;
        this.applyMaskToDOM();
        this.mdContainer.scrollTop = exactScroll;
    }

    toggleTypePanel() {
        const showing = this.typePanel.style.display !== 'none';
        this.typePanel.style.display = showing ? 'none' : 'block';
        this.btnType.toggleClass('echo-btn-active', !showing);
        if (!showing) this.typeInput.focus();
    }

    getPlainReference(): string {
        const wrappers = this.mdContainer.querySelectorAll('.echo-text-wrapper');
        if (wrappers.length) {
            let out = '';
            wrappers.forEach(w => { out += (this.originalTexts.get(w as HTMLElement) ?? w.textContent ?? '') + ' '; });
            return out;
        }
        return this.mdContainer.textContent || '';
    }

    checkTyped() {
        const { correct, total, refWords, matchedRef } = scoreRecall(this.getPlainReference(), this.typeInput.value);
        const pct = total ? Math.round((correct / total) * 100) : 0;

        this.typeResult.empty();
        const summary = this.typeResult.createDiv('echo-type-summary');
        summary.setText(total ? `${pct}%  ·  ${correct} of ${total} words recalled` : 'Nothing to score yet.');
        summary.addClass(pct >= 90 ? 'echo-score-high' : pct >= 60 ? 'echo-score-mid' : 'echo-score-low');

        if (total) {
            const detail = this.typeResult.createDiv('echo-type-detail');
            refWords.forEach((w, idx) => {
                detail.createSpan({ text: w + ' ', cls: matchedRef[idx] ? 'echo-word-hit' : 'echo-word-miss' });
            });
        }
    }

    applyMaskToDOM() {
        if (!this.mdContainer) return;

        let targetPct = 0;
        if (this.currentStep === 2) targetPct = 30;
        if (this.currentStep === 3) targetPct = 60;

        if (this.confidence === 'Moderate' && targetPct > 0) targetPct += 10;
        if (this.confidence === 'Easy' && targetPct > 0) targetPct += 20;

        const ratio = targetPct / 100;
        const cue = cueForStep(this.plugin.settings.cueMode, this.currentStep);

        if (!this.isDomWrapped) {
            const walker = document.createTreeWalker(this.mdContainer, NodeFilter.SHOW_TEXT, null);
            const textNodes: Text[] = [];
            let n: Text | null;
            while ((n = walker.nextNode() as Text)) textNodes.push(n);
            
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
        const wrappers = this.mdContainer.querySelectorAll('.echo-text-wrapper');
        
        wrappers.forEach(wrapper => {
            const original = this.originalTexts.get(wrapper as HTMLElement);
            if (original === undefined) return;

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
            if (s.skipCallouts && el.closest('.callout')) { wrapper.textContent = original; return; }
            if (s.skipCheckboxes && el.closest('.task-list-item')) { wrapper.textContent = original; return; }
            if (s.skipQuotes && el.closest('blockquote:not(.callout)')) { wrapper.textContent = original; return; }
            if (s.excludeInternalLinks && el.closest('.internal-link')) { wrapper.textContent = original; return; }
            if (s.excludeExternalLinks && el.closest('.external-link')) { wrapper.textContent = original; return; }
            if (s.excludeEmbeds && el.closest('.internal-embed')) { wrapper.textContent = original; return; }

            let processed = original;
            const placeholders: string[] = [];
            const escapedMap: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };

            if (s.customRegex) {
                try {
                    const re = new RegExp(s.customRegex, 'g');
                    processed = processed.replace(re, match => {
                        let escapedMatch = match.replace(/[&<>'"]/g, tag => escapedMap[tag] || tag);
                        placeholders.push(escapedMatch);
                        return `\x01${placeholders.length - 1}\x02`;
                    });
                } catch (e) {}
            }

            processed = processed.replace(/[&<>'"]/g, match => {
                placeholders.push(escapedMap[match] || match);
                return `\x01${placeholders.length - 1}\x02`;
            });

            processed = processed.replace(/(\x01\d+\x02|[\p{L}\p{N}]+)/gu, (match) => {
                if (match.startsWith('\x01')) return match; 

                wordIndex++;
                const seed = wordIndex;
                const x = Math.sin(seed) * 10000;
                const rnd = x - Math.floor(x);

                if (rnd < ratio) {
                    const masked = maskWord(match, cue);
                    if (s.enableQuickLook) {
                        return `<span class="echo-blank" data-word="${match}">` + masked + `</span>`;
                    } else {
                        return masked;
                    }
                }
                return match;
            });

            processed = processed.replace(/\x01(\d+)\x02/g, (_, idx) => {
                return placeholders[parseInt(idx, 10)];
            });

            wrapper.innerHTML = processed;

            if (s.enableQuickLook) {
                const blanks = wrapper.querySelectorAll('.echo-blank');
                blanks.forEach(b => {
                    const htmlB = b as HTMLElement;
                    htmlB.onclick = () => {
                        const word = htmlB.getAttribute('data-word');
                        if (word) htmlB.textContent = word;
                        htmlB.classList.add('revealed');
                    };
                });
            }
        });
    }

    async logAndNext(quality?: number) {
        const fm = this.app.metadataCache.getFileCache(this.file)?.frontmatter;

        const confidence = fm?.echo_confidence || 'Hard';
        const deadline = fm?.echo_deadline;

        const history = Array.isArray(fm?.echo_history) ? fm.echo_history : [];
        history.push(getToday());

        const updates: Partial<EchoFrontmatter> = {
            echo_last_revised: getToday(),
            echo_revision_count: (fm?.echo_revision_count || 0) + 1,
            echo_date_added: fm?.echo_date_added || getToday(),
            echo_history: history
        };

        // Feature 4: Record past grades
        const gradesArr = Array.isArray(fm?.echo_past_grades) ? fm.echo_past_grades : [];
        if (quality !== undefined) {
            const gradeStr = Object.keys(SM2_QUALITY).find(key => SM2_QUALITY[key as EchoGrade] === quality) || 'Good';
            gradesArr.push(gradeStr);
            updates.echo_past_grades = gradesArr;
        }

        if (this.plugin.settings.schedulingMode === 'sm2' && quality !== undefined) {
            const prev: Sm2State = {
                ease: typeof fm?.echo_ease === 'number' ? fm.echo_ease : seedEaseFromConfidence(confidence),
                interval: typeof fm?.echo_interval === 'number' ? fm.echo_interval : 0,
                reps: typeof fm?.echo_reps === 'number' ? fm.echo_reps : 0
            };
            const next = sm2(prev, quality);
            const cappedDays = deadlineCap(next.interval, deadline);
            updates.echo_ease = next.ease;
            updates.echo_interval = next.interval;
            updates.echo_reps = next.reps;
            updates.echo_next_due = window.moment().add(cappedDays, 'days').format('YYYY-MM-DD');
            updates.echo_confidence = confidenceFromEase(next.ease);
        } else {
            updates.echo_next_due = calculateNextDue(confidence, deadline);
        }

        await updateNoteFrontmatter(this.app, this.file, updates);

        new Notice(`Logged revision for: ${this.file.basename}`);

        this.currentIndex++;
        if (this.currentIndex < this.queue.length) {
            await this.loadCurrentNote();
        } else {
            this.queue = [];
            this.plugin.activateDashboard();
        }
    }
}

class DashboardItemView extends ItemView {
    viewMode: 'all' | 'tags' | 'archives' = 'all';
    sortCol: keyof DashboardNoteData = 'nextDue';
    sortAsc: boolean = true;
    heatmapOffsetDays: number = 0;

    constructor(leaf: WorkspaceLeaf, public plugin: EchoRecallPlugin) {
        super(leaf);
    }

    getViewType(): string { return ECHO_DASHBOARD_VIEW_TYPE; }
    getDisplayText(): string { return "Echo Recall Dashboard"; }
    getIcon(): string { return "brain"; }

    async onOpen() {
        this.render();
        this.registerEvent(this.app.metadataCache.on('resolved', () => {
            if (this.leaf.view === this) this.render();
        }));
    }

    getVaultData(): DashboardNoteData[] {
        const files = this.app.metadataCache.getCachedFiles();
        const data: DashboardNoteData[] = [];
        const today = getToday();

        for (const path of files) {
            const cache = this.app.metadataCache.getCache(path);
            if (cache?.frontmatter && cache.frontmatter.echo_date_added) {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file instanceof TFile) {
                    const fm = cache.frontmatter;
                    const archived = fm.echo_archived === true;
                    const revisions = fm.echo_revision_count || 0;
                    const confidence = fm.echo_confidence || 'Hard';
                    data.push({
                        file,
                        dateAdded: fm.echo_date_added,
                        title: file.basename,
                        tags: Array.isArray(fm.echo_tags) ? fm.echo_tags : [],
                        revisions: revisions,
                        lastRevised: fm.echo_last_revised || 'Never',
                        confidence: confidence,
                        nextDue: fm.echo_next_due || getToday(),
                        deadline: fm.echo_deadline || '',
                        history: Array.isArray(fm.echo_history) ? fm.echo_history : [],
                        archived: archived,
                        isDue: !archived && (fm.echo_next_due || getToday()) <= today,
                        isLeech: !archived && revisions >= LEECH_REVISIONS && confidence === 'Hard',
                        pastGrades: Array.isArray(fm.echo_past_grades) ? fm.echo_past_grades : []
                    });
                }
            }
        }
        return data;
    }

    render() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('echo-view-container', 'echo-dashboard-container');

        const fullData = this.getVaultData();
        const dueData = fullData.filter(d => d.isDue);

        const header = container.createDiv('echo-dash-header');
        const dueBox = header.createDiv('echo-due-box');
        dueBox.createEl('div', { text: "Due Today", cls: 'echo-due-label' });
        dueBox.createEl('div', { text: dueData.length.toString(), cls: 'echo-due-count' });
        
        const masterPlay = header.createEl('button', { cls: 'echo-master-play' });
        setIcon(masterPlay, 'play');
        masterPlay.createSpan({ text: ' Start Due Notes' });
        masterPlay.onclick = () => {
            if (dueData.length === 0) return new Notice("No notes due today!");
            const files = this.plugin.settings.interleaveDueQueue
                ? interleaveByTag(dueData)
                : dueData.map(d => d.file);
            this.plugin.startRevisionSession(files);
        };

        // Feature 3: Advanced Analytics Panel
        this.renderAnalytics(container, fullData);

        let displayData = fullData;
        if (this.viewMode === 'all' || this.viewMode === 'tags') {
            displayData = fullData.filter(d => !d.archived);
        } else if (this.viewMode === 'archives') {
            displayData = fullData.filter(d => d.archived);
        }

        const controls = container.createDiv('echo-dash-controls');
        controls.createEl('h3', { text: "Vault Notes" });
        const toggles = controls.createDiv('echo-toggles');
        
        const btnAll = toggles.createEl('button', { text: 'View All', cls: `echo-btn ${this.viewMode === 'all' ? 'echo-btn-active' : 'echo-btn-secondary'}` });
        btnAll.onclick = () => { this.viewMode = 'all'; this.render(); };
        
        const btnTags = toggles.createEl('button', { text: 'Tag-wise View', cls: `echo-btn ${this.viewMode === 'tags' ? 'echo-btn-active' : 'echo-btn-secondary'}` });
        btnTags.onclick = () => { this.viewMode = 'tags'; this.render(); };

        const btnArchives = toggles.createEl('button', { text: 'Archives', cls: `echo-btn ${this.viewMode === 'archives' ? 'echo-btn-active' : 'echo-btn-secondary'}` });
        btnArchives.onclick = () => { this.viewMode = 'archives'; this.render(); };

        displayData.sort((a, b) => {
            let valA = a[this.sortCol];
            let valB = b[this.sortCol];
            if (valA < valB) return this.sortAsc ? -1 : 1;
            if (valA > valB) return this.sortAsc ? 1 : -1;
            return 0;
        });

        const tableWrapper = container.createDiv('echo-table-wrapper');
        const table = tableWrapper.createEl('table', { cls: 'echo-table' });

        const thead = table.createEl('thead');
        const trHead = thead.createEl('tr');
        const headers: { label: string, key: keyof DashboardNoteData }[] = [
            { label: 'Date Added', key: 'dateAdded' },
            { label: 'Note Title', key: 'title' },
            { label: 'Tags', key: 'tags' },
            { label: 'Revs', key: 'revisions' },
            { label: 'Last Revised', key: 'lastRevised' },
            { label: 'Confidence', key: 'confidence' },
            { label: 'Action', key: 'file' },
            { label: 'Deadline', key: 'deadline' }
        ];

        headers.forEach(h => {
            const th = trHead.createEl('th', { text: h.label });
            if (h.key !== 'tags' && h.key !== 'file') {
                th.addClass('echo-sortable');
                if (this.sortCol === h.key) th.innerHTML += this.sortAsc ? ' &uarr;' : ' &darr;';
                th.onclick = () => {
                    if (this.sortCol === h.key) this.sortAsc = !this.sortAsc;
                    else { this.sortCol = h.key; this.sortAsc = true; }
                    this.render();
                };
            }
        });

        const tbody = table.createEl('tbody');

        if (this.viewMode === 'all' || this.viewMode === 'archives') {
            displayData.forEach(d => this.renderRow(tbody, d));
        } else if (this.viewMode === 'tags') {
            const grouped: Record<string, DashboardNoteData[]> = { "Untagged": [] };
            displayData.forEach(d => {
                if (d.tags.length === 0) grouped["Untagged"].push(d);
                d.tags.forEach(t => {
                    if (!grouped[t]) grouped[t] = [];
                    grouped[t].push(d);
                });
            });

            Object.entries(grouped).forEach(([tag, notes]) => {
                if (notes.length === 0) return;
                const groupHead = tbody.createEl('tr', { cls: 'echo-tag-header' });
                
                const titleTd = groupHead.createEl('td', { colspan: 3 });
                titleTd.innerHTML = `<div style="display:flex; align-items:center;"><strong>#${tag}</strong> <span class="echo-badge">${notes.length} notes</span></div>`;

                const totalRevs = notes.reduce((sum, n) => sum + n.revisions, 0);
                groupHead.createEl('td', { text: totalRevs.toString(), cls: 'echo-td-center' });
                groupHead.createEl('td');
                
                const hardCount = notes.filter(n => n.confidence === 'Hard').length;
                const modCount = notes.filter(n => n.confidence === 'Moderate').length;
                const easyCount = notes.filter(n => n.confidence === 'Easy').length;
                const totalConf = hardCount + modCount + easyCount;
                
                const hardPct = totalConf ? Math.round((hardCount / totalConf) * 100) : 0;
                const modPct = totalConf ? Math.round((modCount / totalConf) * 100) : 0;
                const easyPct = totalConf ? Math.round((easyCount / totalConf) * 100) : 0;

                const confTd = groupHead.createEl('td');
                confTd.innerHTML = `
                    <div class="echo-tag-conf-wrapper">
                        <div class="echo-tag-conf hard" title="Hard">${hardPct}% H</div>
                        <div class="echo-tag-conf mod" title="Moderate">${modPct}% M</div>
                        <div class="echo-tag-conf easy" title="Easy">${easyPct}% E</div>
                    </div>
                `;
                
                const actionTd = groupHead.createEl('td');
                const actionWrapper = actionTd.createDiv('echo-actions-cell');
                actionWrapper.style.justifyContent = 'flex-start';
                
                const playAllBtn = actionWrapper.createEl('button', { cls: 'echo-btn echo-btn-primary', attr: { 'aria-label': 'Revise All' } });
                playAllBtn.style.display = 'flex'; playAllBtn.style.alignItems = 'center'; playAllBtn.style.gap = '6px'; playAllBtn.style.padding = '4px 12px';
                setIcon(playAllBtn, 'play');
                playAllBtn.createSpan({ text: 'echo all', cls: 'echo-btn-text' });
                playAllBtn.onclick = () => {
                    const toRevise = notes.filter(n => !n.archived).map(n => n.file);
                    if (toRevise.length > 0) this.plugin.startRevisionSession(toRevise);
                    else new Notice("No unarchived notes to revise in this tag.");
                };

                const archAllBtn = actionWrapper.createEl('button', { cls: 'echo-icon-btn echo-tooltip', attr: { 'aria-label': 'Archive All' } });
                archAllBtn.innerText = '🎓';
                archAllBtn.style.fontSize = '0.85em'; archAllBtn.style.padding = '4px 6px';
                archAllBtn.onclick = async () => {
                    new Notice(`Archiving all notes in #${tag}...`);
                    for(const n of notes) {
                        if(!n.archived) await updateNoteFrontmatter(this.app, n.file, { echo_archived: true });
                    }
                };
                
                const deadlineTd = groupHead.createEl('td');
                const deadlineInput = deadlineTd.createEl('input', { type: 'date', cls: 'echo-deadline-input' });
                deadlineInput.title = "Apply deadline to all empty notes in this tag";
                deadlineInput.onchange = async () => {
                    const val = deadlineInput.value;
                    if(val) {
                        new Notice(`Applying deadline to empty notes in #${tag}...`);
                        for(const n of notes) {
                            if(!n.deadline) await updateNoteFrontmatter(this.app, n.file, { echo_deadline: val });
                        }
                    }
                };

                notes.forEach(d => this.renderRow(tbody, d));
            });
        }

        const footer = container.createDiv('echo-dashboard-footer');
        footer.innerHTML = `
            <a href="https://github.com/sajee05/echo-recall" target="_blank">open source</a>, 
            feel free to star the <a href="https://github.com/sajee05/echo-recall" target="_blank">repo</a> | 
            brewed by <a href="https://www.youtube.com/@sxjeel" target="_blank">sxjeel</a> ☕
        `;
    }

    renderAnalytics(container: HTMLElement, data: DashboardNoteData[]) {
        const analyticsWrap = container.createDiv('echo-analytics-wrapper');
        
        // 1. Heatmap
        const counts = new Map<string, number>();
        for (const d of data) {
            for (const day of d.history) counts.set(day, (counts.get(day) || 0) + 1);
        }

        const hmWrap = analyticsWrap.createDiv('echo-heatmap-wrapper');
        const head = hmWrap.createDiv('echo-heatmap-head');
        head.createSpan({ text: 'Revision activity', cls: 'echo-heatmap-title' });
        
        if (counts.size > 0) {
            let max = 1;
            counts.forEach(v => { if (v > max) max = v; });

            const weeks = 26;
            const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
            head.createSpan({ text: `${total} revisions · last ${weeks} weeks`, cls: 'echo-heatmap-sub' });

            const grid = hmWrap.createDiv('echo-heatmap-grid');
            const startWeek = window.moment().startOf('week').subtract(weeks - 1, 'weeks');
            const today = window.moment();
            for (let w = 0; w < weeks; w++) {
                const col = grid.createDiv('echo-heatmap-col');
                for (let dow = 0; dow < 7; dow++) {
                    const day = startWeek.clone().add(w, 'weeks').add(dow, 'days');
                    const key = day.format('YYYY-MM-DD');
                    const c = counts.get(key) || 0;
                    const level = c === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((c / max) * 4)));
                    const cell = col.createDiv(`echo-heatmap-cell echo-hm-${level}`);
                    if (day.isAfter(today, 'day')) cell.addClass('echo-hm-future');
                    const label = `${key}: ${c} revision${c === 1 ? '' : 's'}`;
                    cell.setAttr('aria-label', label);
                    cell.setAttr('title', label);
                }
            }
        } else {
            head.createSpan({ text: `0 revisions`, cls: 'echo-heatmap-sub' });
        }

        // 2. Stats
        const statsWrap = analyticsWrap.createDiv('echo-stats-wrapper');
        let totalRevs = 0, hard = 0, mod = 0, easy = 0, archived = 0, streak = 0;
        const datesSet = new Set<string>();
        
        for (const d of data) {
            totalRevs += d.revisions;
            if (d.archived) archived++;
            else if (d.confidence === 'Hard') hard++;
            else if (d.confidence === 'Moderate') mod++;
            else if (d.confidence === 'Easy') easy++;
            for (const h of d.history) datesSet.add(h);
        }
        
        const todayStr = window.moment().format('YYYY-MM-DD');
        let checkDate = window.moment();
        if (!datesSet.has(todayStr)) checkDate.subtract(1, 'days'); 
        
        while (datesSet.has(checkDate.format('YYYY-MM-DD'))) {
            streak++;
            checkDate.subtract(1, 'days');
        }
        
        let avgDaily = 0;
        if (datesSet.size > 0) {
            const sortedDates = Array.from(datesSet).sort();
            const firstDate = window.moment(sortedDates[0]);
            const daysSinceFirst = Math.max(1, window.moment().diff(firstDate, 'days') + 1);
            avgDaily = Math.round((totalRevs / daysSinceFirst) * 10) / 10;
        }

        statsWrap.innerHTML = `
            <div><strong>Current streak:</strong> ${streak}🔥</div>
            <div><strong>Total revisions:</strong> ${totalRevs}</div>
            <div class="echo-stats-indent">Hard: ${hard}</div>
            <div class="echo-stats-indent">Moderate: ${mod}</div>
            <div class="echo-stats-indent">Easy: ${easy}</div>
            <div class="echo-stats-indent">Archived: ${archived}</div>
            <div><strong>Avg Daily Reviews:</strong> ${avgDaily}</div>
        `;

        // 3. Future Echoes
        const futureWrap = analyticsWrap.createDiv('echo-future-wrapper');
        futureWrap.createDiv({ text: 'Future Echoes:', cls: 'echo-future-title' });
        
        const futureCounts = [0, 0, 0, 0, 0, 0, 0]; 
        for (const d of data) {
            if (d.archived) continue;
            const diff = window.moment(d.nextDue).startOf('day').diff(window.moment().startOf('day'), 'days');
            if (diff <= 0) futureCounts[0]++; 
            else if (diff > 0 && diff < 7) futureCounts[diff]++;
        }
        
        const maxFuture = Math.max(1, ...futureCounts);
        const dayNames = [];
        for (let i=0; i<7; i++) dayNames.push(window.moment().add(i, 'days').format('ddd'));

        const barsWrap = futureWrap.createDiv('echo-future-bars');
        for (let i=0; i<7; i++) {
            const row = barsWrap.createDiv('echo-future-row');
            row.createDiv({ text: dayNames[i], cls: 'echo-future-day' });
            
            const barBox = row.createDiv('echo-future-barbox');
            const pct = (futureCounts[i] / maxFuture) * 100;
            const bar = barBox.createDiv('echo-future-bar');
            bar.style.width = `${pct}%`;
            if (i === 0) bar.style.backgroundColor = 'var(--interactive-accent)';
            
            row.createDiv({ text: `${futureCounts[i]}${i === 0 ? ' (today)' : ''}`, cls: i===0 ? 'echo-future-count echo-future-today' : 'echo-future-count' });
        }
    }

    renderRow(tbody: HTMLElement, data: DashboardNoteData) {
        const tr = tbody.createEl('tr');
        if (data.archived) tr.style.opacity = '0.7';
        
        tr.createEl('td', { text: data.dateAdded, cls: 'echo-td-light' });
        
        const tdTitle = tr.createEl('td');
        const titleLink = tdTitle.createEl('a', { text: data.title, cls: 'echo-title-link' });
        titleLink.onclick = () => this.app.workspace.getLeaf('tab').openFile(data.file);
        if (data.isLeech) {
            const leech = tdTitle.createSpan({ text: '🩸 leech', cls: 'echo-leech-pill' });
            leech.setAttr('aria-label', `Reviewed ${data.revisions}× but still Hard — try re-chunking or elaborating.`);
            leech.setAttr('title', `Reviewed ${data.revisions}× but still Hard — try re-chunking or elaborating.`);
        }

        const tdTags = tr.createEl('td');
        const tagsWrapper = tdTags.createDiv('echo-inline-tags');
        data.tags.forEach(tag => {
            const tagEl = tagsWrapper.createSpan({ text: tag, cls: 'echo-tag-pill' });
            const remBtn = tagEl.createSpan({ text: ' ×', cls: 'echo-tag-remove' });
            remBtn.onclick = async () => {
                await updateNoteFrontmatter(this.app, data.file, { echo_tags: data.tags.filter(t => t !== tag) });
            };
        });
        const tagInput = tagsWrapper.createEl('input', { type: 'text', placeholder: '+ tag', cls: 'echo-tag-input' });
        tagInput.onkeydown = async (e) => {
            if (e.key === 'Enter' && tagInput.value.trim()) {
                const newTags = [...new Set([...data.tags, tagInput.value.trim()])];
                await updateNoteFrontmatter(this.app, data.file, { echo_tags: newTags });
                tagInput.value = '';
            }
        };

        tr.createEl('td', { text: data.revisions.toString(), cls: 'echo-td-center' });
        tr.createEl('td', { text: data.lastRevised, cls: 'echo-td-light' });

        const tdConf = tr.createEl('td');
        const confWrap = tdConf.createDiv('echo-conf-col');
        const select = confWrap.createEl('select', { cls: `echo-conf-select echo-conf-${data.confidence.toLowerCase()}` });
        ['Hard', 'Moderate', 'Easy'].forEach(opt => {
            const option = select.createEl('option', { value: opt, text: opt });
            if (opt === data.confidence) option.selected = true;
        });
        select.onchange = async () => {
            const val = select.value as 'Hard' | 'Moderate' | 'Easy';
            select.className = `echo-conf-select echo-conf-${val.toLowerCase()}`;
            await updateNoteFrontmatter(this.app, data.file, { echo_confidence: val });
        };
        
        // Feature 4: Past Grades visual
        if (this.plugin.settings.schedulingMode === 'sm2' && data.pastGrades.length > 0) {
            const past = data.pastGrades.slice(-3).join(' · ');
            confWrap.createDiv({ text: past, cls: 'echo-past-grades' });
        }

        const tdAction = tr.createEl('td');
        const actionWrapper = tdAction.createDiv('echo-actions-cell');
        actionWrapper.style.justifyContent = 'flex-start';
        
        if (!data.archived) {
            const actBtn = actionWrapper.createEl('button', { cls: 'echo-btn echo-btn-primary', attr: { 'aria-label': 'Revise Now' } });
            actBtn.style.display = 'flex';
            actBtn.style.alignItems = 'center';
            actBtn.style.gap = '6px';
            actBtn.style.padding = '4px 12px';
            setIcon(actBtn, 'play');
            actBtn.createSpan({ text: 'echo', cls: 'echo-btn-text' });
            actBtn.onclick = () => this.plugin.startRevisionSession([data.file]);
        }

        const archBtn = actionWrapper.createEl('button', { cls: 'echo-icon-btn echo-tooltip', attr: { 'aria-label': data.archived ? 'Unarchive' : 'Archive Note' } });
        archBtn.innerText = data.archived ? '🔄' : '🎓';
        archBtn.style.fontSize = '0.85em';
        archBtn.style.padding = '4px 6px';
        archBtn.onclick = async () => {
            await updateNoteFrontmatter(this.app, data.file, { echo_archived: !data.archived });
        };

        const tdDeadline = tr.createEl('td');
        const deadlineInput = tdDeadline.createEl('input', { type: 'date', cls: 'echo-deadline-input' });
        if (data.deadline) deadlineInput.value = data.deadline;
        deadlineInput.onchange = async () => {
            await updateNoteFrontmatter(this.app, data.file, { echo_deadline: deadlineInput.value });
        };
    }
}

export default class EchoRecallPlugin extends Plugin {
    settings: EchoRecallSettings;

    async onload() {
        await this.loadSettings();
        this.injectCSS();

        this.addSettingTab(new EchoRecallSettingsTab(this.app, this));

        this.registerView(ECHO_DASHBOARD_VIEW_TYPE, (leaf) => new DashboardItemView(leaf, this));
        this.registerView(ECHO_REVISION_VIEW_TYPE, (leaf) => new RevisionItemView(leaf, this));

        this.addRibbonIcon('brain', 'Echo Recall Dashboard', () => {
            this.activateDashboard();
        });

        this.app.workspace.onLayoutReady(() => this.injectHeaderButtons());
        this.registerEvent(this.app.workspace.on('layout-change', () => this.injectHeaderButtons()));
        this.registerEvent(this.app.workspace.on('file-open', () => this.injectHeaderButtons()));

        this.addCommand({
            id: 'echo-recall-start-active',
            name: 'Revise active note',
            checkCallback: (checking: boolean) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile) {
                    if (!checking) this.initializeSingleNoteRevision(activeFile);
                    return true;
                }
                return false;
            }
        });

        this.addCommand({
            id: 'echo-recall-open-dashboard',
            name: 'Open Dashboard',
            callback: () => this.activateDashboard()
        });
    }

    injectHeaderButtons() {
        const leaves = this.app.workspace.getLeavesOfType('markdown');
        leaves.forEach(leaf => {
            const view = leaf.view as MarkdownView;
            if (!view || !view.containerEl) return;
            const actions = view.containerEl.querySelector('.view-actions');
            
            if (actions && !actions.querySelector('.echo-header-btn')) {
                const btn = document.createElement('div');
                btn.className = 'clickable-icon view-action echo-header-btn';
                btn.setAttribute('aria-label', 'Revise with Echo Recall');
                
                setIcon(btn, 'play');
                const span = btn.createSpan({text: ' echo'});
                span.style.marginLeft = '4px';
                span.style.fontWeight = 'bold';
                span.style.fontSize = '0.95em';
                
                btn.style.width = 'auto';
                btn.style.padding = '0 10px';
                btn.style.display = 'flex';
                btn.style.alignItems = 'center';
                
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
            leaf = workspace.getLeaf('tab');
            await leaf.setViewState({ type: ECHO_DASHBOARD_VIEW_TYPE, active: true });
        }
        workspace.revealLeaf(leaf);
    }

    async startRevisionSession(files: TFile[]) {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(ECHO_REVISION_VIEW_TYPE)[0];
        if (!leaf) {
            leaf = workspace.getLeaf('tab');
            await leaf.setViewState({ type: ECHO_REVISION_VIEW_TYPE, active: true });
        }
        const view = leaf.view as RevisionItemView;
        await view.startSession(files);
    }

    async initializeSingleNoteRevision(file: TFile) {
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache?.frontmatter?.echo_date_added) {
            await updateNoteFrontmatter(this.app, file, { echo_date_added: getToday(), echo_confidence: 'Hard' });
        }
        this.startRevisionSession([file]);
    }

    injectCSS() {
        const css = `
        .echo-view-container { padding: 20px; font-family: var(--font-interface); max-width: 1100px; width: 100%; margin: 0 auto; box-sizing: border-box; }
        .echo-badge { background: var(--background-modifier-hover); padding: 4px 10px; border-radius: 12px; font-size: 0.8em; font-weight: 500; white-space: nowrap; display: inline-block;}
        .echo-peek-btn { margin-left: 10px; background: var(--background-modifier-hover); transition: color 0.2s; padding: 4px !important; }
        
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

        /* ADVANCED ANALYTICS PANEL */
        .echo-analytics-wrapper { display: flex; gap: 20px; margin-bottom: 25px; flex-wrap: wrap; align-items: stretch; background: var(--background-secondary); border-radius: 12px; border: 1px solid var(--background-modifier-border); padding: 16px 20px;}
        .echo-heatmap-wrapper { flex: 0 0 auto; display: flex; flex-direction: column; gap: 10px; border-right: 1px solid var(--background-modifier-border); padding-right: 20px;}
        .echo-heatmap { margin: 0; padding: 0; border: none; background: transparent; }
        
        .echo-stats-wrapper { display: flex; flex-direction: column; gap: 4px; font-size: 0.9em; justify-content: center; border-right: 1px solid var(--background-modifier-border); padding-right: 20px; min-width: 140px;}
        .echo-stats-indent { padding-left: 15px; color: var(--text-muted); }
        
        .echo-future-wrapper { display: flex; flex-direction: column; gap: 4px; font-size: 0.9em; flex-grow: 1; justify-content: center; min-width: 200px;}
        .echo-future-title { font-weight: bold; margin-bottom: 4px; }
        .echo-future-bars { display: flex; flex-direction: column; gap: 4px; }
        .echo-future-row { display: flex; align-items: center; gap: 8px; }
        .echo-future-day { width: 35px; color: var(--text-muted); }
        .echo-future-barbox { flex-grow: 1; height: 10px; background: var(--background-modifier-border); border-radius: 4px; overflow: hidden; max-width: 250px; }
        .echo-future-bar { height: 100%; background: var(--text-muted); transition: width 0.3s; }
        .echo-future-count { width: 75px; font-size: 0.85em; }
        .echo-future-today { color: var(--interactive-accent); font-weight: bold; }

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

        .echo-conf-col { display: flex; flex-direction: column; align-items: center; }
        .echo-conf-select { border: none; border-radius: 8px; padding: 4px 8px; font-size: 0.9em; cursor: pointer; font-weight: 500; }
        .echo-conf-hard { background: rgba(223, 76, 76, 0.1); color: #df4c4c; }
        .echo-conf-moderate { background: rgba(219, 153, 40, 0.1); color: #db9928; }
        .echo-conf-easy { background: rgba(67, 181, 105, 0.1); color: #43b569; }
        .echo-past-grades { font-size: 0.75em; color: var(--text-muted); text-align: center; margin-top: 4px; font-weight: 500;}
        
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

        .echo-grade-bar { display: flex; gap: 8px; align-items: center; }
        .echo-grade { min-width: 72px; border: 1px solid var(--background-modifier-border); }
        .echo-grade-again { background: rgba(223, 76, 76, 0.12); color: #df4c4c; }
        .echo-grade-hard { background: rgba(219, 153, 40, 0.12); color: #db9928; }
        .echo-grade-good { background: rgba(67, 181, 105, 0.12); color: #43b569; }
        .echo-grade-easy { background: var(--interactive-accent); color: var(--text-on-accent); border-color: transparent; }
        .echo-grade:hover { filter: brightness(1.08); }

        .echo-type-panel { flex-shrink: 0; margin-top: 12px; padding: 14px; border-radius: 12px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); }
        .echo-type-input { width: 100%; min-height: 90px; resize: vertical; border-radius: 8px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); color: var(--text-normal); padding: 10px; font-family: var(--font-text); font-size: 1em; line-height: 1.5; box-sizing: border-box; }
        .echo-type-bar { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
        .echo-type-result { margin-top: 12px; }
        .echo-type-summary { font-weight: 700; font-size: 1.1em; margin-bottom: 8px; }
        .echo-score-high { color: #43b569; }
        .echo-score-mid { color: #db9928; }
        .echo-score-low { color: #df4c4c; }
        .echo-type-detail { line-height: 1.7; }
        .echo-word-hit { color: var(--text-muted); }
        .echo-word-miss { color: var(--text-error); background: rgba(223, 76, 76, 0.12); border-radius: 4px; padding: 0 3px; }

        .echo-leech-pill { margin-left: 8px; font-size: 0.75em; font-weight: 600; color: #df4c4c; background: rgba(223, 76, 76, 0.12); border-radius: 10px; padding: 1px 7px; white-space: nowrap; cursor: help; }

        .echo-heatmap-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; flex-wrap: wrap; gap: 6px; }
        .echo-heatmap-title { font-size: 0.9em; text-transform: uppercase; letter-spacing: 1px; color: var(--text-muted); font-weight:bold;}
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

        @media (max-width: 800px) {
            .echo-analytics-wrapper { flex-direction: column; border-right: none; }
            .echo-heatmap-wrapper, .echo-stats-wrapper { border-right: none; border-bottom: 1px solid var(--background-modifier-border); padding-right: 0; padding-bottom: 20px; }
        }

        @media (max-width: 600px) {
            .echo-dash-header { flex-direction: column; gap: 20px; align-items: flex-start; }
            .echo-bottom-section { flex-direction: column; gap: 15px; }
            .echo-bottom-directive-text { padding: 0; }
            .echo-table-wrapper { font-size: 0.9em; }
            .echo-markdown-content { padding: 15px; }
        }
        `;
        const style = document.createElement('style');
        style.id = 'echo-recall-styles';
        style.textContent = css;
        document.head.appendChild(style);
    }

    onunload() {
        document.getElementById('echo-recall-styles')?.remove();
    }
}

class EchoRecallSettingsTab extends PluginSettingTab {
    plugin: EchoRecallPlugin;

    constructor(app: App, plugin: EchoRecallPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Echo Recall Settings' });
        containerEl.createEl('p', { text: 'Configure which elements should be bypassed by the text masking engine.', cls: 'setting-item-description' });
        containerEl.createEl('br');

        new Setting(containerEl)
            .setName("Scheduling mode")
            .setDesc("Confidence: original fixed 1/7/14-day intervals from the confidence dropdown. "
                + "Adaptive (SM-2): grade your recall at the end of each session and let the interval "
                + "adapt to how well you remembered. Deadlines still shorten the wait in both modes.")
            .addDropdown(drop => drop
                .addOption('confidence', 'Confidence (fixed intervals)')
                .addOption('sm2', 'Adaptive (SM-2)')
                .setValue(this.plugin.settings.schedulingMode)
                .onChange(async (val) => {
                    this.plugin.settings.schedulingMode = val as 'confidence' | 'sm2';
                    await this.plugin.saveSettings();
                    this.display(); // re-render to show/hide the simplify grades toggle
                }));

        if (this.plugin.settings.schedulingMode === 'sm2') {
            new Setting(containerEl)
                .setName("Simplify SM-2 grades")
                .setDesc("Show only 'Good' (Pass) and 'Again' (Fail) buttons to decrease micro-decisions during study.")
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.sm2SimplifyGrades)
                    .onChange(async (val) => {
                        this.plugin.settings.sm2SimplifyGrades = val;
                        await this.plugin.saveSettings();
                    }));
        }

        new Setting(containerEl)
            .setName("Cueing mode")
            .setDesc("How masked words appear. Blank: full underscores (original). First letter: keep "
                + "the first letter as a hint (w____). Graduated: show the first letter on the lighter "
                + "masking step, then withdraw it to full blanks on the heavy step.")
            .addDropdown(drop => drop
                .addOption('blank', 'Blank (____)')
                .addOption('first-letter', 'First letter (w___)')
                .addOption('graduated', 'Graduated (withdraw the cue)')
                .setValue(this.plugin.settings.cueMode)
                .onChange(async (val) => {
                    this.plugin.settings.cueMode = val as 'blank' | 'first-letter' | 'graduated';
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Enable typed recall")
            .setDesc("Adds a '⌨ Type' button in a session to type the passage from memory and score it "
                + "against the note (word-level accuracy).")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableTypedRecall)
                .onChange(async (val) => {
                    this.plugin.settings.enableTypedRecall = val;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Chunking")
            .setDesc("Break a long note into smaller pieces and drill one at a time, then move on. "
                + "Paragraph: split on blank lines (safely maintains Header context). Sentence: split on sentence endings. Off: review the whole note at once.")
            .addDropdown(drop => drop
                .addOption('off', 'Off (whole note)')
                .addOption('paragraph', 'By paragraph')
                .addOption('sentence', 'By sentence')
                .setValue(this.plugin.settings.chunkMode)
                .onChange(async (val) => {
                    this.plugin.settings.chunkMode = val as 'off' | 'paragraph' | 'sentence';
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Interleave due notes")
            .setDesc("When starting your due notes, mix them across their echo tags so consecutive "
                + "notes cover different topics (interleaving improves retention over blocked practice).")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.interleaveDueQueue)
                .onChange(async (val) => {
                    this.plugin.settings.interleaveDueQueue = val;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Enable Quick-Look and Cheating Mode")
            .setDesc("Allows clicking on a blank to reveal the word (turns red to indicate a cheat)")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableQuickLook)
                .onChange(async (val) => {
                    this.plugin.settings.enableQuickLook = val;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Don't revise callouts")
            .setDesc("Skips all text located inside Obsidian callouts")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.skipCallouts)
                .onChange(async (val) => {
                    this.plugin.settings.skipCallouts = val;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Don't revise checkboxes")
            .setDesc("Skips all text inside task/checkbox lines")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.skipCheckboxes)
                .onChange(async (val) => {
                    this.plugin.settings.skipCheckboxes = val;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Don't revise quotes")
            .setDesc("Skips standard blockquotes")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.skipQuotes)
                .onChange(async (val) => {
                    this.plugin.settings.skipQuotes = val;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Exclude internal links")
            .setDesc("Prevents masking text inside [[wikilinks]]")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.excludeInternalLinks)
                .onChange(async (val) => {
                    this.plugin.settings.excludeInternalLinks = val;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Exclude external links")
            .setDesc("Prevents masking text inside [links](urls)")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.excludeExternalLinks)
                .onChange(async (val) => {
                    this.plugin.settings.excludeExternalLinks = val;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Exclude Attachments and embeds")
            .setDesc("Prevents masking embedded files ![[]]")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.excludeEmbeds)
                .onChange(async (val) => {
                    this.plugin.settings.excludeEmbeds = val;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Don't revise custom regex")
            .setDesc("Provide a custom regex string to bypass masking (e.g., \\^\\d+ to skip footnotes)")
            .addText(text => text
                .setPlaceholder("Enter regex...")
                .setValue(this.plugin.settings.customRegex)
                .onChange(async (val) => {
                    this.plugin.settings.customRegex = val;
                    await this.plugin.saveSettings();
                }));

        const footer = containerEl.createDiv('echo-settings-footer');
        footer.innerHTML = `
            <a href="https://github.com/sajee05/echo-recall" target="_blank">open source</a>, 
            feel free to star the <a href="https://github.com/sajee05/echo-recall" target="_blank">repo</a> | 
            brewed by <a href="https://www.youtube.com/@sxjeel" target="_blank">sxjeel</a> ☕
        `;
    }
}
