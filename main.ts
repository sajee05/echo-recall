import {
    App, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, Notice,
    TFile, MarkdownRenderer, setIcon, MarkdownView, Modal, Component
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
    chunkMode: 'off' | 'hierarchical' | 'paragraph' | 'sentence';
    interleaveDueQueue: boolean;
    sm2SimplifyGrades: boolean; 
    enableEchoButton: boolean;

    studyMode: string;
    enableHeavyRecallMode: boolean;
    heavyRecallStep3: boolean;
    ankiDeckName: string;
    ankiTags: string;
    ankiConnectPort: number;
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
    chunkMode: 'hierarchical', 
    interleaveDueQueue: false,
    sm2SimplifyGrades: false,
    enableEchoButton: true,
    studyMode: 'heading',
    enableHeavyRecallMode: true,
    heavyRecallStep3: false,
    ankiDeckName: 'Default',
    ankiTags: 'obsidian',
    ankiConnectPort: 8765
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
    echo_past_grades?: string[]; 
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

interface ChunkData {
    id: string;
    headingText: string;
    immediateHeading: string;
    content: string;
    fullText: string;
}

// --- UTILITIES ---

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunkSize = 32768; // Chunking removes call-stack limit crashes on large images
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    return window.btoa(binary);
}

function stringToHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = (hash << 5) - hash + str.charCodeAt(i);
    return Math.abs(hash).toString(36);
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
        Object.assign(fm, updates);
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

// --- FEATURE 1: CONTEXT-AWARE HIERARCHICAL CHUNKING ---

function generateChunks(text: string, mode: string): ChunkData[] {
    const textTrimmed = text.trim();
    if (!textTrimmed) return [{ id: '0', headingText: '', immediateHeading: '', content: '', fullText: '' }];

    if (mode === 'sentence' || mode === 'off') {
        if (mode === 'off') {
            return [{ id: '0', headingText: '', immediateHeading: '', content: textTrimmed, fullText: textTrimmed }];
        } else {
            const parts = textTrimmed.split(/(?<=[.!?]["'”’)\]]?)\s+(?=["'“‘([]?[A-Z0-9])/);
            const chunks = parts.map(s => s.trim()).filter(Boolean);
            return chunks.length 
                ? chunks.map((c, i) => ({ id: `s_${i}`, headingText: '', immediateHeading: '', content: c, fullText: c })) 
                : [{ id: '0', headingText: '', immediateHeading: '', content: textTrimmed, fullText: textTrimmed }];
        }
    }

    if (mode === 'paragraph') {
        const rawParagraphs = textTrimmed.split(/\n\s*\n+/);
        const chunks = rawParagraphs.map(p => p.trim()).filter(Boolean);
        return chunks.length 
            ? chunks.map((c, i) => ({ id: `p_${i}`, headingText: '', immediateHeading: '', content: c, fullText: c })) 
            : [{ id: '0', headingText: '', immediateHeading: '', content: textTrimmed, fullText: textTrimmed }];
    }

    // Hierarchical Mode
    const lines = textTrimmed.split('\n');
    const chunks: ChunkData[] = [];
    const currentHeadings: { level: number, text: string }[] = [];
    let currentContent: string[] = [];
    let chunkCounter = 0;

    const flush = () => {
        const contentStr = currentContent.join('\n').trim();
        if (contentStr) {
            const headingText = currentHeadings.map(h => h.text).join('\n');
            const immediateHeading = currentHeadings.length > 0 ? currentHeadings[currentHeadings.length - 1].text.replace(/^#+\s/, '').replace(/\*/g,'').trim() : '';
            chunks.push({
                id: `chunk_${chunkCounter++}`,
                headingText: headingText,
                immediateHeading: immediateHeading,
                content: contentStr,
                fullText: (headingText ? headingText + '\n\n' : '') + contentStr
            });
        }
        currentContent = [];
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const hMatch = line.match(/^(#{1,6})\s+(.*)/);
        if (hMatch) {
            flush();
            const level = hMatch[1].length;
            while (currentHeadings.length > 0 && currentHeadings[currentHeadings.length - 1].level >= level) {
                currentHeadings.pop();
            }
            currentHeadings.push({ level, text: line });
        } else {
            currentContent.push(line);
        }
    }
    flush();

    return chunks.length ? chunks : [{ id: '0', headingText: '', immediateHeading: '', content: textTrimmed, fullText: textTrimmed }];
}

// --- ANKI CONNECT INTEGRATION ---

let ANKI_CONNECT_PORT = 8765;

async function seedExistingAnkiMedia(): Promise<Set<string>> {
    const cache = new Set<string>();
    try {
        const names = await ankiRequest('getMediaFilesNames', { pattern: 'echo_*' });
        if (Array.isArray(names)) names.forEach((n: string) => cache.add(n));
    } catch (e) { /* non-fatal */ }
    return cache;
}

class AnkiApiError extends Error {}

async function ankiRequest(action: string, params: any = {}) {
    let brief = ''; let payloadLen = 0;
    try { const s = JSON.stringify(params); payloadLen = s.length; brief = s.length > 300 ? `${s.slice(0, 300)}…(${s.length} chars)` : s; } catch (_) { brief = '[unserializable]'; }
    for (let attempt = 0; ; attempt++) {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timeoutMs = Math.min(600000, Math.max(60000, Math.ceil(payloadLen / 1000) * 150));
        const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
        try {
            const response = await fetch(`http://127.0.0.1:${ANKI_CONNECT_PORT}`, {
                method: 'POST',
                body: JSON.stringify({ action, version: 6, params }),
                signal: ctrl ? ctrl.signal : undefined
            });
            if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
            const result = await response.json();
            if (result.error) throw new AnkiApiError(`AnkiConnect "${action}": ${result.error}`);
            return result.result;
        } catch (e) {
            const isApi = e instanceof AnkiApiError;
            if (!isApi && attempt < 1 && action !== 'addNotes') {
                console.warn(`[Echo Recall][AnkiConnect] ${action} network error, retrying once...`, e);
                await new Promise(r => setTimeout(r, 400));
                continue;
            }
            console.error(`[Echo Recall][AnkiConnect] FAILED action=${action} port=${ANKI_CONNECT_PORT} attempt=${attempt + 1} params=${brief}`, e);
            if (!isApi) console.error('[Echo Recall][AnkiConnect] Hint: Anki must be open, AnkiConnect installed, and the port in Echo Recall settings must match AnkiConnect\'s config. A timeout can mean Anki is busy or a dialog is open.');
            else console.error('[Echo Recall][AnkiConnect] Hint: if this mentions a note being edited, close Anki\'s Browse window and retry.');
            throw e;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
}

const ANKI_MODEL_NAME = 'EchoRecall_v8';
const ANKI_CARD_NAME = 'Echo Recall Card';
const ANKI_TPL_MARKER = '/* echo-tpl:10 */';

const ECHO_ANKI_CSS = `/* echo-tpl:10 */
.card,html,body{--bg-color:#fbfbfd;--surface:#fff;--text-color:#1d1d1f;--text-muted:#6e6e73;--text-error:#d93025;--heading-color:#c2512a;--bold-color:#b8481f;--accent-color:#1f8a3b;--border-color:rgba(60,60,67,.2);--chip:rgba(120,120,128,.13);--mark-bg:rgba(255,204,0,.38);--overlay:rgba(0,0,0,.4)}
.nightMode .card,.night_mode .card,.card.nightMode,.card.night_mode,html.nightMode,html.night_mode,body.nightMode,body.night_mode{--bg-color:#1c1c1e;--surface:#2c2c2e;--text-color:#f2f2f7;--text-muted:#a1a1a6;--text-error:#ff6b63;--heading-color:#ff9f6e;--bold-color:#ffab80;--accent-color:#32d74b;--border-color:rgba(255,255,255,.15);--chip:rgba(235,235,245,.14);--mark-bg:rgba(255,214,10,.3);--overlay:rgba(0,0,0,.62)}
html,body{margin:0;padding:0;background:var(--bg-color)}
.card{margin:0;padding:0;background:var(--bg-color);color:var(--text-color);text-align:left;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:16px;line-height:1.6;-webkit-text-size-adjust:100%;overflow-wrap:break-word;word-wrap:break-word}
.echo-anki-container{display:flex;flex-direction:row;min-height:100vh;width:100%;box-sizing:border-box;outline:none}
.echo-anki-sidebar{position:sticky;top:0;align-self:flex-start;height:100vh;box-sizing:border-box;display:flex;flex-direction:column;flex:0 0 260px;width:260px;padding:20px 16px;border-right:1px solid var(--border-color);background:var(--bg-color)}
.echo-sidebar-title{font-weight:700;font-size:1.05em;line-height:1.3;color:var(--accent-color);padding-bottom:14px;margin-bottom:14px;border-bottom:1px solid var(--border-color)}
.echo-btn-eye{display:block;width:100%;box-sizing:border-box;margin:0 0 10px;padding:10px 14px;border:1px solid var(--border-color);border-radius:10px;background:var(--surface);color:var(--text-color);font-family:inherit;font-size:.88em;font-weight:600;line-height:1.2;text-align:center;cursor:pointer;-webkit-appearance:none;appearance:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
.echo-btn-eye:active{opacity:.65}
@media (hover:hover){.echo-btn-eye:hover{background:var(--chip)}}
.echo-btn-toc{display:none}
.echo-toc-wrap,.echo-toc-panel{display:flex;flex-direction:column;flex:1;min-height:0}
.echo-toc-head{display:none}
.echo-anki-toc{position:relative;flex:1;min-height:0;overflow-y:auto;font-size:.9em;line-height:1.45;padding-right:4px;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.echo-anki-toc ul{list-style:none;margin:0;padding:0}
.echo-anki-toc li{margin:0;padding:5px 8px;border-radius:7px;color:var(--text-muted)}
.echo-anki-toc li.l2{padding-left:20px}.echo-anki-toc li.l3{padding-left:32px}.echo-anki-toc li.l4{padding-left:44px}.echo-anki-toc li.l5{padding-left:56px}.echo-anki-toc li.l6{padding-left:68px}
.echo-anki-toc li.cur{color:var(--accent-color);font-weight:700;background:var(--chip)}
.echo-anki-content{flex:1;min-width:0;max-width:860px;margin:0 auto;box-sizing:border-box;padding:36px 48px 56px;font-size:1.05em}
.echo-blanked{padding:40px 20px;border:2px dashed var(--border-color);border-radius:14px;text-align:center;color:var(--text-muted);margin-top:16px;font-style:italic;clear:both}
.echo-full-note{display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:1000;box-sizing:border-box;padding:3%;background:var(--overlay)}
.echo-full-note.open{display:flex}
.echo-fn-box{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--surface);color:var(--text-color);border:1px solid var(--border-color);border-radius:14px;overflow:hidden}
.echo-fn-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-bottom:1px solid var(--border-color);font-weight:700}
.echo-fn-bar .echo-btn-eye{width:auto;margin:0;padding:7px 14px}
.echo-fn-body{flex:1;overflow-y:auto;padding:24px 32px;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
h1,h2,h3,h4,h5,h6{color:var(--heading-color);font-weight:650;line-height:1.3;margin:1.4em 0 .5em}
.echo-anki-content h2.immediate-heading{color:var(--accent-color);text-align:center;margin:0 0 24px;font-size:1.55em;padding-bottom:14px;border-bottom:1px solid var(--border-color)}
.echo-breadcrumbs{display:block;text-align:center;font-size:.85em;font-weight:600;line-height:1.4;color:var(--text-muted);margin:0 0 10px}
.echo-bc-sep{color:var(--accent-color);margin:0 6px;font-weight:700}
strong,b{color:var(--bold-color);font-weight:650}
em,i{color:var(--accent-color)}
hr{border:0;border-top:1px solid var(--border-color);margin:24px 0}
table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse;margin:14px 0}
th,td{border:1px solid var(--border-color);padding:8px 10px}
th{color:var(--accent-color);font-weight:700;background:var(--chip)}
blockquote{margin:14px 0;padding:8px 14px;border-left:4px solid var(--accent-color);background:var(--chip);border-radius:0 8px 8px 0}
img,video,svg{max-width:100%;height:auto}
img{display:block;margin:14px 0;border-radius:10px}
.nightMode img,.night_mode img{background:rgba(255,255,255,.92)}
audio{max-width:100%}
mark{background:var(--mark-bg);color:inherit;padding:1px 4px;border-radius:4px}
u{text-decoration-color:var(--accent-color);text-underline-offset:3px;text-decoration-thickness:2px}
code{background:var(--chip);padding:2px 6px;border-radius:5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em}
pre{background:var(--chip);padding:14px;border-radius:10px;overflow-x:auto;border:1px solid var(--border-color);margin:14px 0}
pre code{background:transparent;padding:0;border-radius:0;color:inherit}
ul,ol{padding-left:22px;margin:6px 0}
ul{list-style-type:disc}ul ul{list-style-type:circle}
li{margin-bottom:5px}
li::marker{color:var(--accent-color)}
mjx-container{max-width:100%;overflow-x:auto;overflow-y:hidden;vertical-align:middle}
a{color:var(--accent-color)}
.echo-obsidian-link{display:inline-block;margin-top:28px;color:var(--heading-color);text-decoration:none;font-weight:700;font-size:.9em}
@media (max-width:900px){.echo-anki-sidebar{flex-basis:220px;width:220px}.echo-anki-content{padding:28px 28px 48px}}
@media (max-width:600px),(max-height:430px){
.echo-anki-container{flex-direction:column}
.echo-anki-sidebar{position:static;align-self:stretch;height:auto;flex:none;width:auto;padding:10px 14px 2px;border-right:0;border-bottom:1px solid var(--border-color);background:transparent;text-align:center}
.echo-sidebar-title{padding-bottom:8px;margin-bottom:8px;font-size:.98em;line-height:1.3;text-align:center}
.echo-anki-sidebar .echo-btn-eye{padding:7px 12px;margin-bottom:8px;font-size:.82em}
.echo-btn-toc{display:block}
.echo-toc-wrap{display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:1100;flex:none;justify-content:flex-end;background:var(--overlay)}
.echo-toc-open .echo-toc-wrap{display:flex}
.echo-toc-panel{flex:none;max-height:80%;box-sizing:border-box;padding:14px 14px 18px;background:var(--surface);border-radius:16px 16px 0 0;overflow:hidden}
.echo-toc-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-weight:700}
.echo-toc-head .echo-btn-eye{width:auto;margin:0;padding:6px 14px}
.echo-anki-toc{flex:1 1 auto}
.echo-anki-content{padding:18px 16px 40px;font-size:1em}
.echo-anki-content h2.immediate-heading{font-size:1.35em}
.echo-full-note{padding:0}
.echo-fn-box{border:0;border-radius:0}
.echo-fn-body{padding:16px}
}`;

const ECHO_ANKI_JS = `(function(){
var d=document,$=function(i){return d.getElementById(i)};
window.echoSc=function(){var c=$('etoc'),u=c&&c.querySelector('li.cur');if(c&&u&&c.clientHeight)c.scrollTop=Math.max(0,u.offsetTop-(c.clientHeight-u.offsetHeight)/2)};
window.echoToc=function(o){var e=$('ec');if(!e)return;if(o){e.classList.add('echo-toc-open');window.echoSc()}else e.classList.remove('echo-toc-open')};
window.echoFn=function(o){var f=$('fn');if(!f)return;if(o){var b=$('fnb');if(b&&!b.firstChild){var t=$('eft');if(t){if(t.content)b.appendChild(t.content.cloneNode(true));else b.innerHTML=t.innerHTML}}f.classList.add('open')}else f.classList.remove('open')};
if(!window.__echoK){window.__echoK=1;d.addEventListener('keydown',function(e){if(e.key!=='Escape')return;var f=$('fn'),c=$('ec');if(f&&f.classList.contains('open'))window.echoFn(0);else if(c&&c.classList.contains('echo-toc-open'))window.echoToc(0);else return;e.preventDefault();e.stopPropagation()},true)}
function lv(li){var m=/(^| )l([1-6])( |$)/.exec(li.className);if(m)return +m[2];var ml=parseInt(li.style.marginLeft,10);return isNaN(ml)?1:Math.round(ml/15)+1}
try{
var h=d.querySelector('.immediate-heading'),t=$('etoc');
if(h&&t&&!d.querySelector('.echo-breadcrumbs')){
var it=t.getElementsByTagName('li'),cur=t.querySelector('li.cur'),ht=h.textContent.trim(),i,j,idx=-1;
if(!cur&&ht){for(i=0;i<it.length;i++){if(it[i].textContent.trim()===ht){cur=it[i];cur.classList.add('cur');break}}}
if(cur){
for(i=0;i<it.length;i++){if(it[i]===cur){idx=i;break}}
var p=[cur.textContent.trim()],L=lv(cur);
for(j=idx-1;j>=0&&L>1;j--){var l2=lv(it[j]);if(l2<L){p.unshift(it[j].textContent.trim());L=l2}}
var b=d.createElement('div');b.className='echo-breadcrumbs';
for(i=0;i<p.length;i++){if(i){var s=d.createElement('span');s.className='echo-bc-sep';s.textContent='/';b.appendChild(s)}b.appendChild(d.createTextNode(p[i]))}
h.parentNode.insertBefore(b,h);
window.echoSc();
}}
}catch(err){}
setTimeout(function(){if(d.body&&d.body.focus)d.body.focus()},50);
})();`;

function echoCardTemplate(back: boolean): string {
    const main = back
        ? `<div>{{Content}}</div>
                <a class="echo-obsidian-link" href="{{ObsidianURI}}">▶ Open in Obsidian</a>`
        : ``;
    return `<div class="echo-anki-container" id="ec" tabindex="0">
    <div class="echo-anki-sidebar">
        <div class="echo-sidebar-title">{{NoteTitle}}</div>
        <button type="button" class="echo-btn-eye echo-btn-toc" onclick="echoToc(1)">☰ TOC</button>
        <button type="button" class="echo-btn-eye" onclick="echoFn(1)">👁 View Full Note</button>
        <div class="echo-toc-wrap" onclick="if(event.target===this)echoToc(0)">
            <div class="echo-toc-panel">
                <div class="echo-toc-head"><span>Contents</span><button type="button" class="echo-btn-eye" onclick="echoToc(0)">Close</button></div>
                <div class="echo-anki-toc" id="etoc">{{HeadingPath}}</div>
            </div>
        </div>
    </div>
    <div class="echo-anki-content">
        {{#ImmediateHeading}}<h2 class="immediate-heading">{{ImmediateHeading}}</h2>{{/ImmediateHeading}}
        ${main}
    </div>
</div>
<div id="fn" class="echo-full-note" onclick="if(event.target===this)echoFn(0)">
    <div class="echo-fn-box">
        <div class="echo-fn-bar"><span>{{NoteTitle}}</span><button type="button" class="echo-btn-eye" onclick="echoFn(0)">Close</button></div>
        <div class="echo-fn-body" id="fnb"></div>
    </div>
</div>
<template id="eft">{{FullNote}}</template>
<script>${ECHO_ANKI_JS}</script>`;
}

async function setupAnkiNoteType(): Promise<void> {
    try {
        const models: string[] = await ankiRequest('modelNames');
        if (!models.includes(ANKI_MODEL_NAME)) {
            console.log('[Echo Recall][Anki] Creating note type', ANKI_MODEL_NAME);
            await ankiRequest('createModel', {
                modelName: ANKI_MODEL_NAME,
                inOrderFields: ['ChunkID', 'NoteTitle', 'HeadingPath', 'ImmediateHeading', 'Content', 'FullNote', 'ObsidianURI', '_WARNING'],
                css: `${ANKI_TPL_MARKER}\n${ECHO_ANKI_CSS}`,
                isCloze: false,
                cardTemplates: [{ Name: ANKI_CARD_NAME, Front: echoCardTemplate(false), Back: echoCardTemplate(true) }]
            });
            return;
        }
        const styling = await ankiRequest('modelStyling', { modelName: ANKI_MODEL_NAME });
        if (!styling || typeof styling.css !== 'string' || !styling.css.includes(ANKI_TPL_MARKER)) {
            console.log('[Echo Recall][Anki] Upgrading card template/styling to', ANKI_TPL_MARKER);
            await ankiRequest('updateModelStyling', { model: { name: ANKI_MODEL_NAME, css: `${ANKI_TPL_MARKER}\n${ECHO_ANKI_CSS}` } });
            await ankiRequest('updateModelTemplates', {
                model: { name: ANKI_MODEL_NAME, templates: { [ANKI_CARD_NAME]: { Front: echoCardTemplate(false), Back: echoCardTemplate(true) } } }
            });
        }
    } catch (e) {
        console.error('[Echo Recall][Anki] Note type setup/upgrade failed. Is Anki open with AnkiConnect installed?', e);
        throw e;
    }
}

interface AnkiNoteInfo { noteId: number; fields: Record<string, { value: string }>; }
interface AnkiPayload { uid: string; fields: Record<string, string>; }
interface AnkiUpdateStats { updated: number; refreshed: number; relinked: number; added: number; unchanged: number; orphaned: number; failed: number; notExported: boolean; }

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function extractTocLines(body: string): { level: number, text: string }[] {
    const out: { level: number, text: string }[] = [];
    for (const l of body.split('\n')) {
        const m = l.match(/^(#{1,6})\s+(.*)/);
        if (m) out.push({ level: m[1].length, text: m[2].replace(/\*/g, '').trim() });
    }
    return out;
}

function buildLocalToc(lines: { level: number, text: string }[], immediateHeading: string): string {
    if (!lines.length) return '<i>Full Note / Paragraph</i>';
    let marked = false;
    let html = '<ul>';
    for (const h of lines) {
        const cur = !marked && immediateHeading !== '' && immediateHeading === h.text;
        if (cur) marked = true;
        html += `<li class="l${h.level}${cur ? ' cur' : ''}">${escHtml(h.text)}</li>`;
    }
    return html + '</ul>';
}

function ankiFilePrefix(file: TFile): string {
    return `echo_${stringToHash(file.path)}_`;
}

function computeChunkUids(file: TFile, chunks: ChunkData[]): string[] {
    const seen = new Map<string, number>();
    return chunks.map(c => {
        const base = `${ankiFilePrefix(file)}${stringToHash(c.headingText || c.content.substring(0, 50))}`;
        const n = (seen.get(base) || 0) + 1;
        seen.set(base, n);
        return n === 1 ? base : `${base}_${n}`;
    });
}

function ankiField(n: AnkiNoteInfo, key: string): string {
    return (n.fields && n.fields[key] && typeof n.fields[key].value === 'string') ? n.fields[key].value : '';
}

function textTokens(html: string): Set<string> {
    return new Set(html.replace(/<[^>]*>/g, ' ').toLowerCase().split(/\s+/).filter(w => w.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (!a.size && !b.size) return 1;
    let inter = 0;
    a.forEach(x => { if (b.has(x)) inter++; });
    return inter / (a.size + b.size - inter);
}

const ankiSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function findAnkiNotes(query: string, keep?: (n: AnkiNoteInfo) => boolean): Promise<AnkiNoteInfo[]> {
    const ids: number[] = await ankiRequest('findNotes', { query });
    const out: AnkiNoteInfo[] = [];
    for (let i = 0; i < ids.length; i += 40) {
        const infos: AnkiNoteInfo[] = await ankiRequest('notesInfo', { notes: ids.slice(i, i + 40) });
        for (const n of infos) if (n && n.noteId && (!keep || keep(n))) out.push(n);
    }
    return out;
}

function logAnkiError(context: string, e: any, extra: Record<string, any> = {}) {
    console.error(`[Echo Recall] ${context} FAILED`, {
        message: e && e.message ? e.message : String(e),
        stack: e && e.stack ? e.stack : undefined,
        ...extra
    });
}

async function processHtmlMedia(app: App, file: TFile, component: Component, markdown: string, ankiSync: boolean = false, depth: number = 0, mediaCache: Set<string> = new Set(), noteCache: Map<string, string> = new Map(), visiting: Set<string> = new Set()): Promise<string> {
    if (depth > 6) return "<span style='color:var(--text-error); font-size:0.8em;'>[Link depth limit reached]</span>";

    const myVisiting = new Set(visiting);
    myVisiting.add(file.path);

    let processed = markdown;
    const placeholders: Record<string, string> = {};
    let placeholderCounter = 0;

    if (ankiSync) {
        // 1. Process Media BEFORE rendering
        const wikiRegex = /!\[\[([^\]|]+?)\\?(?:\|([^\]]*))?\]\]/g;
        const mdRegex = /!\[([^\]]*)\]\((<[^>]+>|[^)]+)\)/g;

        const replaceMedia = async (match: string, filename: string, sizeOrAlt: string) => {
            const clean = filename.trim().replace(/^<|>$/g, '').replace(/\\$/, '').split('#')[0].trim();
            if (/^(https?:|data:)/i.test(clean)) return match;
            let decoded = clean;
            try { decoded = decodeURIComponent(clean); } catch (_) { /* literal % in filename */ }
            const destFile = app.metadataCache.getFirstLinkpathDest(decoded, file.path) || app.metadataCache.getFirstLinkpathDest(clean, file.path);
            const mkPlaceholder = (html: string) => {
                const pid = `ECHOMODALPLACEHOLDER${placeholderCounter}END`;
                placeholderCounter++;
                placeholders[pid] = html;
                return pid;
            };
            if (!(destFile instanceof TFile) && /\.(png|jpe?g|gif|webp|svg|bmp|avif|mp3|wav|ogg|m4a|flac|mp4|webm)$/i.test(clean)) {
                console.warn(`[Echo Recall] Media not found in vault, referenced from ${file.path}: ${clean}`);
                return mkPlaceholder(`<span style="opacity:0.6;font-size:0.85em">[Image not found: ${escHtml(clean)}]</span>`);
            }
            if (destFile instanceof TFile && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'mp3', 'wav', 'ogg', 'm4a', 'flac', 'mp4', 'webm'].includes(destFile.extension.toLowerCase())) {
                const ankiFilename = `echo_${stringToHash(destFile.path)}_${destFile.name}`;
                if (!mediaCache.has(ankiFilename)) {
                    try {
                        const arr = await app.vault.readBinary(destFile);
                        const b64 = arrayBufferToBase64(arr);
                        await ankiRequest('storeMediaFile', { filename: ankiFilename, data: b64 });
                        mediaCache.add(ankiFilename);
                    } catch (me) {
                        console.error(`[Echo Recall] Failed to upload media "${destFile.path}" (${destFile.stat ? destFile.stat.size : '?'} bytes) to Anki`, me);
                        return mkPlaceholder(`<span style="opacity:0.6;font-size:0.85em">[Image failed to upload: ${escHtml(destFile.name)}]</span>`);
                    }
                }
                
                let widthAttr = "";
                if (sizeOrAlt) {
                    const wMatch = sizeOrAlt.match(/^(\d+)(x\d+)?$/);
                    if (wMatch) { widthAttr = `width="${wMatch[1]}"`; } 
                    else {
                        const maybeNum = parseInt(sizeOrAlt.replace(/[^0-9]/g, ''));
                        if(!isNaN(maybeNum) && maybeNum > 0) widthAttr = `width="${maybeNum}"`;
                    }
                }
                const imgHtml = `<img src="${ankiFilename}" ${widthAttr} style="max-width: 100%; height: auto; border-radius: 8px; margin: 10px 0; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">`;
                const ext = destFile.extension.toLowerCase();
                const mediaHtml = ['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)
                    ? `<audio controls src="${ankiFilename}"></audio>`
                    : ['mp4', 'webm'].includes(ext)
                        ? `<video controls src="${ankiFilename}" style="max-width:100%"></video>`
                        : imgHtml;
                return mkPlaceholder(mediaHtml);
            }
            return match;
        };

        const wikiMatches = [...processed.matchAll(wikiRegex)];
        for (const m of wikiMatches) { processed = processed.replace(m[0], await replaceMedia(m[0], m[1], m[2])); }
        const mdMatches = [...processed.matchAll(mdRegex)];
        for (const m of mdMatches) { processed = processed.replace(m[0], await replaceMedia(m[0], m[2], m[1])); }
    }

    // 2. Extract Linked Notes into Safe Placeholders
    if (ankiSync) {
        const noteLinkRegex = /(!?)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]*))?\]\]/g;
        const linkMatches = [...processed.matchAll(noteLinkRegex)];
        
        for (const m of linkMatches) {
            const isEmbed = m[1] === '!';
            const linkTarget = m[2].trim().replace(/\\$/, '');
            const displayText = m[3] ? m[3].trim() : linkTarget;
            
            if (linkTarget.match(/\.(png|jpg|jpeg|gif|webp|svg|mp3|mp4)$/i)) continue;

            const destFile = app.metadataCache.getFirstLinkpathDest(linkTarget, file.path);
            
            if (destFile instanceof TFile && destFile.extension === 'md') {
                let linkedNoteHtml = "";
                if (myVisiting.has(destFile.path)) {
                    linkedNoteHtml = `<em style="opacity:0.6">[Circular link to "${displayText}" — not expanded to avoid a loop]</em>`;
                } else if (noteCache.has(destFile.path)) {
                    linkedNoteHtml = noteCache.get(destFile.path) as string;
                } else {
                    const noteContent = await app.vault.read(destFile);
                    let cleanContent = noteContent;
                    
                    const cleanContentMatch = noteContent.match(/^---\n[\s\S]*?\n---\n/);
                    if (cleanContentMatch) cleanContent = noteContent.slice(cleanContentMatch[0].length);
                    
                    linkedNoteHtml = await processHtmlMedia(app, destFile, component, cleanContent.trim(), true, depth + 1, mediaCache, noteCache, myVisiting);
                    noteCache.set(destFile.path, linkedNoteHtml);
                }
                
                const pid = `ECHOMODALPLACEHOLDER${placeholderCounter}END`;
                placeholderCounter++;
                
                if (isEmbed) {
                    placeholders[pid] = `<div style="border-left: 4px solid var(--accent-color, #43b569); padding: 15px 20px; margin: 15px 0; background: rgba(0,0,0,0.03); border-radius: 0 8px 8px 0;"><strong>${displayText}</strong><hr style="margin: 10px 0; opacity:0.5;">${linkedNoteHtml}</div>`;
                } else {
                    const modalId = 'modal_' + stringToHash(destFile.path + Math.random().toString());
                    placeholders[pid] = `<span onclick="var m=document.getElementById('${modalId}'); if(m.parentNode!==document.body)document.body.appendChild(m); m.style.display='flex'; event.preventDefault(); event.stopPropagation();" style="color:var(--accent-color, #43b569); cursor:pointer; font-weight:bold; border-bottom: 1.5px dashed var(--accent-color, #43b569); transition: opacity 0.2s;">&#91;&#91;${displayText}&#93;&#93;</span><div id="${modalId}" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.65); z-index:99999; justify-content:center; align-items:center; -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);" onclick="this.style.display='none'; event.preventDefault(); event.stopPropagation();"><div style="background:var(--bg-color, #262831); color:var(--text-color, #c9cdd2); padding:35px 45px; border-radius:12px; width:85%; max-width:850px; max-height:85%; overflow-y:auto; border:1px solid var(--border-color, #3b3e48); box-shadow: 0 15px 50px rgba(0,0,0,0.5); text-align: left; position: relative; cursor:default; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;" onclick="event.stopPropagation()"><div style="font-weight:bold; font-size:1.4em; color:var(--heading-color, #d07353); margin-bottom:20px; border-bottom:1px solid var(--border-color, #3b3e48); padding-bottom:15px; display:flex; justify-content:space-between; align-items:center;"><span>🔗 ${displayText}</span><span onclick="document.getElementById('${modalId}').style.display='none'; event.stopPropagation();" style="cursor:pointer; color:var(--text-muted, #888); font-size: 1.2em; padding: 5px; background: rgba(0,0,0,0.1); border-radius: 6px; width:30px; height:30px; display:flex; align-items:center; justify-content:center;">✖</span></div><div style="font-size: 1em; line-height: 1.6;">${linkedNoteHtml}</div></div></div>`;
                }
                processed = processed.replace(m[0], pid);
            }
        }
    }

    const div = document.createElement('div');
    await MarkdownRenderer.render(app, processed, div, file.path, component);
    let finalHtml = div.innerHTML;

    if (ankiSync) {
        for (const [pid, html] of Object.entries(placeholders)) {
            finalHtml = finalHtml.split(pid).join(html);
        }
    }

    return finalHtml;
}

// --- VIEWS ---

class RevisionItemView extends ItemView {
    queue: TFile[] = [];
    currentIndex: number = 0;
    currentStep: 1 | 2 | 3 = 1;
    scrollPos: number = 0;
    
    confidence: string = 'Hard';
    originalTexts: WeakMap<HTMLElement | Text, string> = new WeakMap();
    isDomWrapped: boolean = false;

    chunks: ChunkData[] = [];       
    currentChunk: number = 0;
    originalFullBody: string = "";
    file: TFile;

    headerTitle: HTMLElement;
    headerCount: HTMLElement;
    peekBtn: HTMLElement;
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
            if (this.plugin.settings.enableHeavyRecallMode) {
                if (this.currentStep === 3) {
                    this.currentStep = 2;
                    this.currentChunk = this.chunks.length - 1;
                    this.updateStepUI();
                } else if (this.currentStep === 2) {
                    if (this.currentChunk > 0) {
                        this.currentChunk--;
                        this.updateStepUI();
                    } else {
                        this.currentStep = 1;
                        this.updateStepUI();
                    }
                }
            } else {
                if (this.currentStep > 1) { this.currentStep--; this.updateStepUI(); }
            }
        };

        this.bottomDirectiveText = this.bottomSection.createDiv('echo-bottom-directive-text');
        const rightControls = this.bottomSection.createDiv('echo-controls-right');

        this.btnType = rightControls.createEl('button', { text: '⌨ Type', cls: 'echo-btn echo-btn-nav echo-btn-secondary' });
        this.btnType.onclick = () => this.toggleTypePanel();

        this.btnNext = rightControls.createEl('button', { text: 'Next', cls: 'echo-btn echo-btn-nav echo-btn-active' });
        this.btnNext.onclick = () => { 
            if (this.plugin.settings.enableHeavyRecallMode) {
                if (this.currentStep === 1) {
                    this.currentStep = 2;
                    this.currentChunk = 0;
                    this.updateStepUI();
                } else if (this.currentStep === 2) {
                    if (this.currentChunk < this.chunks.length - 1) {
                        this.currentChunk++;
                        this.updateStepUI();
                    } else {
                        if (this.plugin.settings.heavyRecallStep3) {
                            this.currentStep = 3;
                            this.updateStepUI();
                        }
                    }
                }
            } else {
                if (this.currentStep < 3) { this.currentStep++; this.updateStepUI(); }
            }
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

        this.chunks = generateChunks(body, this.plugin.settings.chunkMode);
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

        await this.updateStepUI();
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

    async updateStepUI() {
        const sm2Mode = this.plugin.settings.schedulingMode === 'sm2';
        const heavyMode = this.plugin.settings.enableHeavyRecallMode;
        const total = this.chunks.length;
        let maxSteps = heavyMode && !this.plugin.settings.heavyRecallStep3 ? 2 : 3;

        if (heavyMode) {
            this.headerCount.textContent = total > 1
                ? `Note ${this.currentIndex + 1}/${this.queue.length} · chunk ${this.currentStep === 2 ? (this.currentChunk + 1) : '-'}/${total}`
                : `Note ${this.currentIndex + 1} of ${this.queue.length}`;
        } else {
            this.headerCount.textContent = total > 1
                ? `Note ${this.currentIndex + 1}/${this.queue.length} · chunk ${this.currentChunk + 1}/${total}`
                : `Note ${this.currentIndex + 1} of ${this.queue.length}`;
        }

        this.peekBtn.style.display = (this.currentStep === 3 && !heavyMode) ? 'none' : 'flex';

        if (heavyMode) {
            if (this.currentStep === 1) {
                this.topDirective.innerHTML = "<span><strong>Step 1: Skim</strong> - Get a general overview of all topics.</span>";
                this.bottomDirectiveText.innerHTML = "Read through the entire note to prime your memory.";
            } else if (this.currentStep === 2) {
                this.topDirective.innerHTML = "<span><strong>Step 2: Recall</strong> - Chunkwise Brainstorming.</span>";
                this.bottomDirectiveText.innerHTML = "Recall everything under this heading before checking.";
            } else if (this.currentStep === 3) {
                this.topDirective.innerHTML = "<span><strong>Step 3: Final Test</strong> - The entire note is blanked.</span>";
                this.bottomDirectiveText.innerHTML = "Mentally outline the whole structure.";
            }
        } else {
            if (this.currentStep === 1) {
                this.topDirective.innerHTML = "<span>Firstly, <strong style='color: var(--text-error)'>say it</strong> at least a few times.</span>";
                this.bottomDirectiveText.innerHTML = "It's best to repeat this step until you know the flow of the text.";
            } else if (this.currentStep === 2) {
                this.topDirective.innerHTML = "<span>Secondly, <strong style='color: var(--text-error)'>say it without mistakes.</strong></span>";
                this.bottomDirectiveText.innerHTML = "Make sure you're comfortable with every line of the text.";
            } else {
                this.topDirective.innerHTML = "<span>Thirdly, <strong style='color: var(--text-error)'>say it without pausing.</strong></span>";
                this.bottomDirectiveText.innerHTML = "If you're unsure about a word, go back two steps and reread that part.";
            }
        }

        const isLastChunk = this.currentChunk >= this.chunks.length - 1;

        if (heavyMode) {
            this.btnBack.disabled = (this.currentStep === 1);
            this.btnBack.style.opacity = (this.currentStep === 1) ? '0.3' : '1';

            if (this.currentStep === 1) {
                this.btnNext.style.display = 'block';
                this.btnFinish.style.display = 'none';
                this.gradeBar.style.display = 'none';
            } else if (this.currentStep === 2) {
                if (!isLastChunk || maxSteps === 3) {
                    this.btnNext.style.display = 'block';
                    this.btnFinish.style.display = 'none';
                    this.gradeBar.style.display = 'none';
                } else {
                    this.btnNext.style.display = 'none';
                    if (sm2Mode) {
                        this.btnFinish.style.display = 'none';
                        this.gradeBar.style.display = 'flex';
                        this.gradeBar.empty();
                        const grades: EchoGrade[] = this.plugin.settings.sm2SimplifyGrades ? ['Again', 'Good'] : ['Again', 'Hard', 'Good', 'Easy'];
                        grades.forEach(g => {
                            const b = this.gradeBar.createEl('button', { text: g, cls: `echo-btn echo-btn-nav echo-grade echo-grade-${g.toLowerCase()}` });
                            b.onclick = async () => { await this.logAndNext(SM2_QUALITY[g]); };
                        });
                    } else {
                        this.btnFinish.style.display = 'block';
                        this.btnFinish.textContent = (this.currentIndex < this.queue.length - 1) ? "Finish & Next Note" : "Finish & Log";
                        this.gradeBar.style.display = 'none';
                    }
                }
            } else if (this.currentStep === 3) {
                this.btnNext.style.display = 'none';
                if (sm2Mode) {
                    this.btnFinish.style.display = 'none';
                    this.gradeBar.style.display = 'flex';
                    this.gradeBar.empty();
                    const grades: EchoGrade[] = this.plugin.settings.sm2SimplifyGrades ? ['Again', 'Good'] : ['Again', 'Hard', 'Good', 'Easy'];
                    grades.forEach(g => {
                        const b = this.gradeBar.createEl('button', { text: g, cls: `echo-btn echo-btn-nav echo-grade echo-grade-${g.toLowerCase()}` });
                        b.onclick = async () => { await this.logAndNext(SM2_QUALITY[g]); };
                    });
                } else {
                    this.btnFinish.style.display = 'block';
                    this.btnFinish.textContent = (this.currentIndex < this.queue.length - 1) ? "Finish & Next Note" : "Finish & Log";
                    this.gradeBar.style.display = 'none';
                }
            }
        } else {
            this.btnBack.disabled = (this.currentStep === 1);
            this.btnBack.style.opacity = (this.currentStep === 1) ? '0.3' : '1';
            this.btnNext.style.display = (this.currentStep < 3) ? 'block' : 'none';

            if (this.currentStep < 3) {
                this.btnFinish.style.display = 'none';
                this.gradeBar.style.display = 'none';
            } else {
                if (!isLastChunk) {
                    this.btnFinish.style.display = 'block';
                    this.btnFinish.textContent = "Next chunk";
                    this.gradeBar.style.display = 'none';
                } else if (sm2Mode) {
                    this.btnFinish.style.display = 'none';
                    this.gradeBar.style.display = 'flex';
                    this.gradeBar.empty();
                    const grades: EchoGrade[] = this.plugin.settings.sm2SimplifyGrades ? ['Again', 'Good'] : ['Again', 'Hard', 'Good', 'Easy'];
                    grades.forEach(g => {
                        const b = this.gradeBar.createEl('button', { text: g, cls: `echo-btn echo-btn-nav echo-grade echo-grade-${g.toLowerCase()}` });
                        b.onclick = async () => { await this.logAndNext(SM2_QUALITY[g]); };
                    });
                } else {
                    this.btnFinish.style.display = 'block';
                    this.btnFinish.textContent = (this.currentIndex < this.queue.length - 1) ? "Finish & Next Note" : "Finish & Log";
                    this.gradeBar.style.display = 'none';
                }
            }
        }

        this.btnType.style.display = this.plugin.settings.enableTypedRecall ? 'block' : 'none';

        this.mdContainer.empty();

        if (heavyMode) {
            if (this.currentStep === 1) {
                await MarkdownRenderer.render(this.app, this.originalFullBody, this.mdContainer, this.file.path, this);
            } else if (this.currentStep === 2) {
                const chunk = this.chunks[this.currentChunk];
                if (chunk.headingText) {
                    const hWrap = this.mdContainer.createDiv('echo-heavy-headings');
                    await MarkdownRenderer.render(this.app, chunk.headingText, hWrap, this.file.path, this);
                }
                const blankWrap = this.mdContainer.createDiv('echo-heavy-blank');
                const btn = blankWrap.createEl('button', { text: '👁 Reveal Content', cls: 'echo-btn echo-btn-primary' });
                const cWrap = blankWrap.createDiv({ cls: 'echo-heavy-content' });
                cWrap.style.display = 'none';
                await MarkdownRenderer.render(this.app, chunk.content, cWrap, this.file.path, this);
                btn.onclick = () => { cWrap.style.display = 'block'; btn.style.display = 'none'; };
            } else if (this.currentStep === 3) {
                const blankWrap = this.mdContainer.createDiv('echo-heavy-blank');
                const btn = blankWrap.createEl('button', { text: '👁 Reveal Full Note', cls: 'echo-btn echo-btn-primary' });
                const cWrap = blankWrap.createDiv({ cls: 'echo-heavy-content' });
                cWrap.style.display = 'none';
                await MarkdownRenderer.render(this.app, this.originalFullBody, cWrap, this.file.path, this);
                btn.onclick = () => { cWrap.style.display = 'block'; btn.style.display = 'none'; };
            }
        } else {
            this.isDomWrapped = false;
            this.originalTexts = new WeakMap();
            await MarkdownRenderer.render(this.app, this.chunks[this.currentChunk].fullText, this.mdContainer, this.file.path, this);
            const exactScroll = this.mdContainer.scrollTop;
            this.applyMaskToDOM();
            this.mdContainer.scrollTop = exactScroll;
        }
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
    ankiBusy = false;

    async onload() {
        await this.loadSettings();
        this.injectCSS();

        this.addSettingTab(new EchoRecallSettingsTab(this.app, this));

        this.registerView(ECHO_DASHBOARD_VIEW_TYPE, (leaf) => new DashboardItemView(leaf, this));
        this.registerView(ECHO_REVISION_VIEW_TYPE, (leaf) => new RevisionItemView(leaf, this));

        this.addRibbonIcon('brain', 'Echo Recall Dashboard', () => {
            this.activateDashboard();
        });

        // Feature 3: Anki Export Buttons
        this.addRibbonIcon('layers', 'Export Note to Anki (Echo Recall)', async () => {
            const file = this.app.workspace.getActiveFile();
            if (file) await this.exportNoteToAnki(file);
            else new Notice('No active note to export.');
        });
        
        this.addRibbonIcon('refresh-cw', 'Update Anki Cards (Echo Recall)', async () => {
            const file = this.app.workspace.getActiveFile();
            if (file) await this.updateAnkiCards(file);
            else new Notice('No active note to update.');
        });

        this.app.workspace.onLayoutReady(() => {
            this.injectHeaderButtons();
            setupAnkiNoteType().catch(() => { /* already logged; Anki may simply be closed */ });
        });
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

        this.addCommand({
            id: 'echo-recall-export-anki', name: 'Export active note to Anki',
            callback: () => {
                const f = this.app.workspace.getActiveFile();
                if (f) this.exportNoteToAnki(f);
            }
        });

        this.addCommand({
            id: 'echo-recall-update-anki', name: 'Differential update Anki cards',
            callback: () => {
                const f = this.app.workspace.getActiveFile();
                if (f) this.updateAnkiCards(f);
            }
        });

        this.addCommand({
            id: 'echo-recall-update-anki-all', name: 'Differential update ALL exported notes in Anki',
            callback: () => this.updateAllAnkiCards()
        });
    }

    // --- ANKI EXPORT LOGIC ---

    async createDeckIfNeeded() {
        const deck = this.settings.ankiDeckName;
        try {
            const decks = await ankiRequest('deckNames');
            if (!decks.includes(deck)) await ankiRequest('createDeck', { deck });
        } catch (e) {
            new Notice('Failed to connect to AnkiConnect. Is Anki open?');
            throw e;
        }
    }

    async prepareAnkiPayloads(file: TFile, body: string, onProgress: (m: string) => void): Promise<AnkiPayload[]> {
        const chunks = generateChunks(body, this.settings.chunkMode);
        const mediaCache = await seedExistingAnkiMedia();
        const noteCache = new Map<string, string>();
        onProgress('Echo Recall: Processing full note media...');
        console.log(`[Echo Recall] Processing full note HTML and media for ${file.path}...`);
        const fullNoteHtml = await processHtmlMedia(this.app, file, this, body, true, 0, mediaCache, noteCache);
        const obsidianUri = `obsidian://open?vault=${encodeURIComponent(this.app.vault.getName())}&file=${encodeURIComponent(file.path)}`;
        const toc = extractTocLines(body);
        const uids = computeChunkUids(file, chunks);
        const out: AnkiPayload[] = [];
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            onProgress(`Echo Recall: Processing chunk ${i + 1} of ${chunks.length}...`);
            console.log(`[Echo Recall] Processing chunk ${i + 1}/${chunks.length} (${uids[i]})...`);
            out.push({
                uid: uids[i],
                fields: {
                    ChunkID: uids[i],
                    NoteTitle: file.basename,
                    HeadingPath: buildLocalToc(toc, chunk.immediateHeading),
                    ImmediateHeading: escHtml(chunk.immediateHeading),
                    Content: await processHtmlMedia(this.app, file, this, chunk.content, true, 0, mediaCache, noteCache),
                    FullNote: fullNoteHtml,
                    ObsidianURI: obsidianUri,
                    _WARNING: 'DO NOT EDIT IN ANKI. Obsidian is the source of truth.'
                }
            });
        }
        return out;
    }

    async addAnkiPayloads(payloads: AnkiPayload[], deckName: string, setMsg: (m: string) => void): Promise<{ added: number, skipped: number }> {
        const tags = this.settings.ankiTags.split(',').map(t => t.trim()).filter(Boolean);
        const notes = payloads.map(p => ({ deckName, modelName: ANKI_MODEL_NAME, fields: p.fields, tags, options: { allowDuplicate: false } }));
        let added = 0, skipped = 0;
        const BATCH_SIZE = 5;
        const MAX_BATCH_CHARS = 400000;
        let batchNo = 0;
        for (let i = 0; i < notes.length; ) {
            const batch: typeof notes = [];
            let batchChars = 0;
            while (i < notes.length && batch.length < BATCH_SIZE) {
                const len = JSON.stringify(notes[i]).length;
                if (batch.length > 0 && batchChars + len > MAX_BATCH_CHARS) break;
                batch.push(notes[i]); batchChars += len; i++;
            }
            batchNo++;
            setMsg(`Echo Recall: Sending notes ${i - batch.length + 1} to ${i} of ${notes.length}...`);
            try {
                const results = await ankiRequest('addNotes', { notes: batch });
                results.forEach((r: any) => r === null ? skipped++ : added++);
            } catch (batchErr) {
                logAnkiError(`addNotes batch ${batchNo}`, batchErr, { deckName, chunkIds: batch.map(b => b.fields.ChunkID) });
                throw batchErr;
            }
            await ankiSleep(250);
        }
        return { added, skipped };
    }

    async exportNoteToAnki(file: TFile) {
        if (this.ankiBusy) { new Notice('Echo Recall: an Anki export/update is already running.'); return; }
        this.ankiBusy = true;
        const exportNotice = new Notice('Echo Recall: Initializing Anki export...', 0);
        const setMsg = (m: string) => { exportNotice.noticeEl.innerText = m; };
        console.log(`[Echo Recall] Starting export for: ${file.path}`);
        try {
            await this.createDeckIfNeeded();
            await setupAnkiNoteType();
            const { body } = extractFrontmatter(await this.app.vault.read(file));
            const payloads = await this.prepareAnkiPayloads(file, body, setMsg);
            setMsg(`Echo Recall: Sending ${payloads.length} notes to Anki in batches...`);
            const { added, skipped } = await this.addAnkiPayloads(payloads, this.settings.ankiDeckName, setMsg);
            exportNotice.hide();
            new Notice(`Anki Export Complete: ${added} added, ${skipped} skipped.`);
            console.log(`[Echo Recall] Export Complete. ${added} added, ${skipped} skipped.`);
            if (skipped > 0) new Notice("Skipped cards might already exist. Try the Update command.");
        } catch (e) {
            logAnkiError('Anki export', e, { file: file.path });
            exportNotice.hide();
            new Notice('Anki export failed. Check console for details.', 5000);
        } finally {
            this.ankiBusy = false;
        }
    }

    async runAnkiUpdate(file: TFile, setMsg: (m: string) => void): Promise<AnkiUpdateStats> {
        const stats: AnkiUpdateStats = { updated: 0, refreshed: 0, relinked: 0, added: 0, unchanged: 0, orphaned: 0, failed: 0, notExported: false };
        const tag = `[Echo Recall][Update][${file.path}]`;
        await setupAnkiNoteType();
        const { body } = extractFrontmatter(await this.app.vault.read(file));
        const payloads = await this.prepareAnkiPayloads(file, body, setMsg);

        setMsg(`Echo Recall: Searching all of Anki for "${file.basename}" cards...`);
        const prefix = ankiFilePrefix(file);
        const encPath = encodeURIComponent(file.path);
        const existing = await findAnkiNotes(`"ChunkID:${prefix.replace(/_/g, '\\_')}*"`, n => {
            if (!ankiField(n, 'ChunkID').startsWith(prefix)) return false;
            const uri = ankiField(n, 'ObsidianURI');
            return !uri || uri.includes(encPath);
        });
        if (!existing.length) {
            stats.notExported = true;
            console.warn(`${tag} No Anki notes found for this file. Export it first.`);
            return stats;
        }

        const byUid = new Map<string, AnkiNoteInfo>();
        for (const n of existing) {
            const id = ankiField(n, 'ChunkID');
            if (byUid.has(id)) console.warn(`${tag} Duplicate ChunkID ${id} (note ${n.noteId}) ignored; keeping note ${byUid.get(id)!.noteId}.`);
            else byUid.set(id, n);
        }
        const wanted = new Set(payloads.map(p => p.uid));
        const pool: AnkiNoteInfo[] = Array.from(byUid.entries()).filter(e => !wanted.has(e[0])).map(e => e[1]);
        const pairs: { note: AnkiNoteInfo, payload: AnkiPayload, relink: boolean }[] = [];
        const fresh: AnkiPayload[] = [];
        for (const p of payloads) {
            const n = byUid.get(p.uid);
            if (n) pairs.push({ note: n, payload: p, relink: false });
            else fresh.push(p);
        }

        // Chunks whose ID changed (heading renamed / first words edited): relink to the closest orphaned card so scheduling is kept.
        const tokCache = new Map<number, Set<string>>();
        const tokOf = (n: AnkiNoteInfo) => { let t = tokCache.get(n.noteId); if (!t) { t = textTokens(ankiField(n, 'Content')); tokCache.set(n.noteId, t); } return t; };
        const brandNew: AnkiPayload[] = [];
        for (const p of fresh) {
            const pc = p.fields.Content.trim();
            let idx = pool.findIndex(o => ankiField(o, 'Content').trim() === pc);
            if (idx < 0) {
                const pt = textTokens(pc);
                let best = -1, bestScore = 0.499;
                pool.forEach((o, i) => { const s = jaccard(pt, tokOf(o)); if (s > bestScore) { bestScore = s; best = i; } });
                idx = best;
            }
            if (idx >= 0) { pairs.push({ note: pool[idx], payload: p, relink: true }); pool.splice(idx, 1); }
            else brandNew.push(p);
        }

        const keys = ['ChunkID', 'NoteTitle', 'HeadingPath', 'ImmediateHeading', 'Content', 'FullNote', 'ObsidianURI'];
        let n = 0;
        for (const { note, payload, relink } of pairs) {
            n++;
            setMsg(`Echo Recall: Updating card ${n} of ${pairs.length}...`);
            const changed: Record<string, string> = {};
            for (const k of keys) if (payload.fields[k] !== ankiField(note, k)) changed[k] = payload.fields[k];
            if (!Object.keys(changed).length) { stats.unchanged++; continue; }
            const contentChanged = 'Content' in changed && changed.Content.trim() !== ankiField(note, 'Content').trim();
            try {
                await ankiRequest('updateNoteFields', { note: { id: note.noteId, fields: changed } });
                if (contentChanged) {
                    try {
                        const cards: number[] = await ankiRequest('findCards', { query: `nid:${note.noteId}` });
                        if (cards.length > 0) await ankiRequest('forgetCards', { cards });
                    } catch (re) { logAnkiError(`${tag} resetting cards of note ${note.noteId}`, re); }
                    stats.updated++;
                } else stats.refreshed++;
                if (relink) { stats.relinked++; console.log(`${tag} Relinked note ${note.noteId} -> ${payload.uid}`); }
            } catch (ue) {
                stats.failed++;
                logAnkiError(`${tag} updateNoteFields note ${note.noteId}`, ue, { chunkId: payload.uid, changedFields: Object.keys(changed) });
            }
            await ankiSleep(30);
        }

        if (brandNew.length) {
            let deck = this.settings.ankiDeckName;
            try {
                const cards: number[] = await ankiRequest('findCards', { query: `nid:${existing[0].noteId}` });
                if (cards.length) {
                    const info = await ankiRequest('cardsInfo', { cards: [cards[0]] });
                    if (info && info[0] && info[0].deckName) deck = info[0].deckName;
                }
            } catch (de) { logAnkiError(`${tag} resolving sibling deck (falling back to "${deck}")`, de); }
            try {
                await ankiRequest('createDeck', { deck });
                const r = await this.addAnkiPayloads(brandNew, deck, setMsg);
                stats.added += r.added;
                if (r.skipped) console.warn(`${tag} ${r.skipped} new chunk(s) were skipped as duplicates.`);
            } catch (ae) {
                stats.failed += brandNew.length;
                logAnkiError(`${tag} adding new chunks`, ae, { deck, chunkIds: brandNew.map(b => b.uid) });
            }
        }

        stats.orphaned = pool.length;
        for (const o of pool) console.warn(`${tag} Orphaned card (chunk no longer in note, NOT deleted): note ${o.noteId}, ${ankiField(o, 'ChunkID')}`);
        console.log(`${tag} Done`, stats);
        return stats;
    }

    summarizeAnkiStats(s: AnkiUpdateStats): string {
        if (s.notExported) return 'not exported to Anki yet (use Export first)';
        const parts = [`${s.updated} content-updated & reset`, `${s.refreshed} headings/full-note refreshed`];
        if (s.relinked) parts.push(`${s.relinked} renamed chunks relinked`);
        if (s.added) parts.push(`${s.added} new added`);
        if (s.orphaned) parts.push(`${s.orphaned} orphaned (kept)`);
        if (s.failed) parts.push(`${s.failed} FAILED (see console)`);
        return parts.join(', ');
    }

    async updateAnkiCards(file: TFile) {
        if (this.ankiBusy) { new Notice('Echo Recall: an Anki export/update is already running.'); return; }
        this.ankiBusy = true;
        const notice = new Notice('Echo Recall: Initializing Anki update...', 0);
        const setMsg = (m: string) => { notice.noticeEl.innerText = m; };
        console.log(`[Echo Recall] Starting update for: ${file.path}`);
        try {
            const stats = await this.runAnkiUpdate(file, setMsg);
            notice.hide();
            new Notice(`Anki Update: ${this.summarizeAnkiStats(stats)}.`, 8000);
        } catch (e) {
            logAnkiError('Anki update', e, { file: file.path });
            notice.hide();
            new Notice('Anki update failed. Check console for details.', 5000);
        } finally {
            this.ankiBusy = false;
        }
    }

    async updateAllAnkiCards() {
        if (this.ankiBusy) { new Notice('Echo Recall: an Anki export/update is already running.'); return; }
        this.ankiBusy = true;
        const notice = new Notice('Echo Recall: Scanning Anki for exported notes...', 0);
        const setMsg = (m: string) => { notice.noticeEl.innerText = m; };
        try {
            await setupAnkiNoteType();
            const ids: number[] = await ankiRequest('findNotes', { query: '"ChunkID:echo\\_*"' });
            const vault = this.app.vault.getName();
            const paths = new Set<string>();
            for (let i = 0; i < ids.length; i += 25) {
                const infos: AnkiNoteInfo[] = await ankiRequest('notesInfo', { notes: ids.slice(i, i + 25) });
                for (const info of infos) {
                    if (!info || !info.noteId) continue;
                    const m = /vault=([^&]*)(?:&amp;|&)file=([^&"]*)/.exec(ankiField(info, 'ObsidianURI'));
                    if (!m) continue;
                    try { if (decodeURIComponent(m[1]) === vault) paths.add(decodeURIComponent(m[2])); } catch (de) { console.warn('[Echo Recall] Bad ObsidianURI skipped', m[0], de); }
                }
            }
            const list = Array.from(paths);
            console.log(`[Echo Recall] Update-all: ${ids.length} Anki notes across ${list.length} Obsidian files.`);
            let ok = 0, missing = 0, failed = 0;
            for (let i = 0; i < list.length; i++) {
                const f = this.app.vault.getAbstractFileByPath(list[i]);
                if (!(f instanceof TFile)) { missing++; console.warn(`[Echo Recall][Update-all] File not found in vault (renamed/deleted?): ${list[i]}`); continue; }
                try {
                    const st = await this.runAnkiUpdate(f, m => setMsg(`[${i + 1}/${list.length}] ${f.basename}: ${m}`));
                    if (st.failed) failed++; else ok++;
                } catch (fe) { failed++; logAnkiError(`Update-all file ${f.path}`, fe); }
            }
            notice.hide();
            new Notice(`Anki Update-all: ${ok} notes updated, ${failed} with errors, ${missing} missing in vault.`, 8000);
        } catch (e) {
            logAnkiError('Anki update-all', e);
            notice.hide();
            new Notice('Anki update-all failed. Check console for details.', 5000);
        } finally {
            this.ankiBusy = false;
        }
    }

    injectHeaderButtons() {
        const leaves = this.app.workspace.getLeavesOfType('markdown');
        leaves.forEach(leaf => {
            const view = leaf.view as MarkdownView;
            if (!view || !view.containerEl) return;
            const actions = view.containerEl.querySelector('.view-actions');
            if(!actions) return;
            
            const existingBtn = actions.querySelector('.echo-header-btn');
            
            if (!this.settings.enableEchoButton) {
                if (existingBtn) existingBtn.remove();
                return;
            }
            
            if (!existingBtn) {
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
        const saved = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
        if (!saved || saved.studyMode === undefined) {
            this.settings.studyMode = this.settings.heavyRecallStep3 ? 'full' : this.settings.enableHeavyRecallMode ? 'heading' : 'echo';
        }
        ANKI_CONNECT_PORT = this.settings.ankiConnectPort || 8765;
    }

    async saveSettings() {
        ANKI_CONNECT_PORT = this.settings.ankiConnectPort || 8765;
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

        .echo-heavy-headings { margin-bottom: 10px; opacity: 0.8; }
        .echo-heavy-blank { padding: 30px; text-align: center; border: 2px dashed var(--background-modifier-border); border-radius: 12px; margin-top: 20px;}
        .echo-heavy-content { margin-top: 20px; text-align: left; }

        .echo-mode-select { display: flex; flex-direction: column; border: 1px solid var(--background-modifier-border); border-radius: 10px; overflow: hidden; margin-bottom: 4px; }
        .echo-mode-option, .echo-mode-suboption { display: flex; gap: 12px; align-items: flex-start; padding: 14px 16px; cursor: pointer; border-bottom: 1px solid var(--background-modifier-border); }
        .echo-mode-select .echo-mode-option:last-child { border-bottom: none; }
        .echo-mode-option input[type="radio"], .echo-mode-suboption input[type="checkbox"] { margin-top: 3px; cursor: pointer; }
        .echo-mode-text { display: flex; flex-direction: column; gap: 4px; }
        .echo-mode-title { font-weight: 600; cursor: pointer; }
        .echo-mode-desc { font-size: 0.9em; color: var(--text-muted); }
        .echo-mode-suboption { border: 1px solid var(--background-modifier-border); border-radius: 10px; margin: 10px 0 20px 24px; background: var(--background-secondary); }

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
      containerEl.createEl("h2", { text: "Echo Recall Settings" });
      containerEl.createEl("h3", { text: "Recall Mode" });
      containerEl.createEl("p", { text: "Choose how content is hidden during recall.", cls: "setting-item-description" });
      const modeWrap = containerEl.createDiv("echo-mode-select");
      const modeOptions = [
        { id: "heading", title: "Heading Recall", desc: "Recall entire sections from their headings.", best: "Concepts, ideas, theories, summaries and explanations." },
        { id: "echo", title: "Fill in the Blank", desc: "Recall hidden words and phrases in the text.", best: "Poetry, speeches, quotations, definitions and exact wording." }
      ];
      let fullNoteRow: HTMLElement | null = null;
      const refreshFullNoteVisibility = () => {
        if (fullNoteRow) fullNoteRow.style.display = this.plugin.settings.studyMode === "heading" ? "flex" : "none";
      };
      modeOptions.forEach((opt) => {
        const row = modeWrap.createDiv("echo-mode-option");
        const radio = row.createEl("input", { type: "radio", attr: { name: "echo-study-mode", id: `echo-mode-${opt.id}` } });
        radio.checked = this.plugin.settings.studyMode === opt.id;
        const textWrap = row.createDiv("echo-mode-text");
        const label = textWrap.createEl("label", { text: opt.title, attr: { for: `echo-mode-${opt.id}` } });
        label.addClass("echo-mode-title");
        textWrap.createDiv({ text: opt.desc, cls: "echo-mode-desc" });
        const bestLine = textWrap.createDiv({ cls: "echo-mode-desc" });
        bestLine.createEl("strong", { text: "Best for: " });
        bestLine.appendText(opt.best);
        const selectMode = async () => {
          this.plugin.settings.studyMode = opt.id;
          this.plugin.settings.enableHeavyRecallMode = opt.id === "heading";
          if (opt.id !== "heading") this.plugin.settings.heavyRecallStep3 = false;
          await this.plugin.saveSettings();
          modeWrap.querySelectorAll('input[type="radio"]').forEach((rr) => {
          const r = rr as HTMLInputElement;
            r.checked = r.id === `echo-mode-${opt.id}`;
          });
          refreshFullNoteVisibility();
        };
        radio.onchange = selectMode;
        row.onclick = (e) => {
          if (e.target !== radio) selectMode();
        };
      });
      const fnRow = containerEl.createDiv("echo-mode-suboption");
      fullNoteRow = fnRow;
      const fullCheckbox = fnRow.createEl("input", { type: "checkbox", attr: { id: "echo-full-note-check" } });
      fullCheckbox.checked = this.plugin.settings.heavyRecallStep3;
      fullCheckbox.onchange = async () => {
        this.plugin.settings.heavyRecallStep3 = fullCheckbox.checked;
        await this.plugin.saveSettings();
      };
      const fullLabel = fnRow.createDiv("echo-mode-text");
      fullLabel.createEl("label", { text: "Also test the full note at the end", attr: { for: "echo-full-note-check" }, cls: "echo-mode-title" });
      fullLabel.createDiv({ text: "After finishing every heading, add one last round where the ENTIRE note is hidden at once — the hardest possible test.", cls: "echo-mode-desc" });
      refreshFullNoteVisibility();
      containerEl.createEl("br");
      containerEl.createEl("h3", { text: "Anki Export" });
      const ankiInfo = containerEl.createEl("p", { cls: "setting-item-description" });
      ankiInfo.innerHTML = `Exporting to Anki requires the free <a href="https://ankiweb.net/shared/info/2055492159" target="_blank">AnkiConnect</a> add-on installed in Anki, and Anki must be <strong>open</strong> while you export or update. Install it from Anki: Tools → Add-ons → Get Add-ons… → code <strong>2055492159</strong> → restart Anki.`;
      new Setting(containerEl).setName("AnkiConnect port").setDesc("The port AnkiConnect listens on. Leave as 8765 unless you changed it in AnkiConnect's own config (Anki → Add-ons → AnkiConnect → Config).").addText((text) => text.setPlaceholder("8765").setValue(String(this.plugin.settings.ankiConnectPort)).onChange(async (val) => {
        const port = parseInt(val, 10);
        this.plugin.settings.ankiConnectPort = isNaN(port) ? 8765 : port;
        await this.plugin.saveSettings();
      }));
      new Setting(containerEl).setName("Deck name").setDesc("Which Anki deck exported notes go into. Created automatically if it doesn't exist.").addText((text) => text.setPlaceholder("Default").setValue(this.plugin.settings.ankiDeckName).onChange(async (val) => {
        this.plugin.settings.ankiDeckName = val;
        await this.plugin.saveSettings();
      }));
      new Setting(containerEl).setName("Tags").setDesc("Comma-separated tags added to every exported Anki card.").addText((text) => text.setPlaceholder("obsidian").setValue(this.plugin.settings.ankiTags).onChange(async (val) => {
        this.plugin.settings.ankiTags = val;
        await this.plugin.saveSettings();
      }));
      containerEl.createEl("br");
      containerEl.createEl("h3", { text: "General Masking Settings" });
      containerEl.createEl("p", { text: "Configure which elements should be bypassed by the text masking engine.", cls: "setting-item-description" });
      containerEl.createEl("br");
      new Setting(containerEl).setName("Scheduling mode").setDesc("Confidence: original fixed 1/7/14-day intervals from the confidence dropdown. Adaptive (SM-2): grade your recall at the end of each session and let the interval adapt to how well you remembered. Deadlines still shorten the wait in both modes.").addDropdown((drop) => drop.addOption("confidence", "Confidence (fixed intervals)").addOption("sm2", "Adaptive (SM-2)").setValue(this.plugin.settings.schedulingMode).onChange(async (val) => {
        this.plugin.settings.schedulingMode = val;
        await this.plugin.saveSettings();
        this.display();
      }));
      if (this.plugin.settings.schedulingMode === "sm2") {
        new Setting(containerEl).setName("Simplify SM-2 grades").setDesc("Show only 'Good' (Pass) and 'Again' (Fail) buttons to decrease micro-decisions during study.").addToggle((toggle) => toggle.setValue(this.plugin.settings.sm2SimplifyGrades).onChange(async (val) => {
          this.plugin.settings.sm2SimplifyGrades = val;
          await this.plugin.saveSettings();
        }));
      }
      new Setting(containerEl).setName("Cueing mode").setDesc("How masked words appear. Blank: full underscores (original). First letter: keep the first letter as a hint (w____). Graduated: show the first letter on the lighter masking step, then withdraw it to full blanks on the heavy step.").addDropdown((drop) => drop.addOption("blank", "Blank (____)").addOption("first-letter", "First letter (w___)").addOption("graduated", "Graduated (withdraw the cue)").setValue(this.plugin.settings.cueMode).onChange(async (val) => {
        this.plugin.settings.cueMode = val;
        await this.plugin.saveSettings();
      }));
      new Setting(containerEl).setName("Enable typed recall").setDesc("Adds a '\u2328 Type' button in a session to type the passage from memory and score it against the note (word-level accuracy).").addToggle((toggle) => toggle.setValue(this.plugin.settings.enableTypedRecall).onChange(async (val) => {
        this.plugin.settings.enableTypedRecall = val;
        await this.plugin.saveSettings();
      }));
      new Setting(containerEl).setName("Enable [\u25B6 echo] Button").setDesc("Show the echo button in the top right header of your notes.").addToggle((toggle) => toggle.setValue(this.plugin.settings.enableEchoButton).onChange(async (val) => {
        this.plugin.settings.enableEchoButton = val;
        await this.plugin.saveSettings();
        this.plugin.injectHeaderButtons();
      }));
      new Setting(containerEl).setName("Chunking").setDesc("Break a long note into pieces. Paragraph: standard block split. Hierarchical: context-aware block split safely on headings. Sentence: split on periods. Off: whole note.").addDropdown((drop) => drop.addOption("off", "Off (whole note)").addOption("hierarchical", "Hierarchical (Context-aware)").addOption("paragraph", "Paragraph by paragraph").addOption("sentence", "By sentence").setValue(this.plugin.settings.chunkMode).onChange(async (val) => {
        this.plugin.settings.chunkMode = val;
        await this.plugin.saveSettings();
      }));
      new Setting(containerEl).setName("Interleave due notes").setDesc("When starting your due notes, mix them across their echo tags so consecutive notes cover different topics (interleaving improves retention over blocked practice).").addToggle((toggle) => toggle.setValue(this.plugin.settings.interleaveDueQueue).onChange(async (val) => {
        this.plugin.settings.interleaveDueQueue = val;
        await this.plugin.saveSettings();
      }));
      new Setting(containerEl).setName("Click-to-reveal blanks").setDesc("Lets you click any blanked word to reveal it mid-session (shown in red so you know you peeked).").addToggle((toggle) => toggle.setValue(this.plugin.settings.enableQuickLook).onChange(async (val) => {
        this.plugin.settings.enableQuickLook = val;
        await this.plugin.saveSettings();
      }));
      new Setting(containerEl).setName("Don't revise callouts").setDesc("Skips all text located inside Obsidian callouts").addToggle((toggle) => toggle.setValue(this.plugin.settings.skipCallouts).onChange(async (val) => {
        this.plugin.settings.skipCallouts = val;
        await this.plugin.saveSettings();
      }));
      new Setting(containerEl).setName("Don't revise checkboxes").setDesc("Skips all text inside task/checkbox lines").addToggle((toggle) => toggle.setValue(this.plugin.settings.skipCheckboxes).onChange(async (val) => {
        this.plugin.settings.skipCheckboxes = val;
        await this.plugin.saveSettings();
      }));
      new Setting(containerEl).setName("Don't revise quotes").setDesc("Skips standard blockquotes").addToggle((toggle) => toggle.setValue(this.plugin.settings.skipQuotes).onChange(async (val) => {
        this.plugin.settings.skipQuotes = val;
        await this.plugin.saveSettings();
      }));
      new Setting(containerEl).setName("Exclude internal links").setDesc("Prevents masking text inside [[wikilinks]]").addToggle((toggle) => toggle.setValue(this.plugin.settings.excludeInternalLinks).onChange(async (val) => {
        this.plugin.settings.excludeInternalLinks = val;
        await this.plugin.saveSettings();
      }));
      new Setting(containerEl).setName("Exclude external links").setDesc("Prevents masking text inside [links](urls)").addToggle((toggle) => toggle.setValue(this.plugin.settings.excludeExternalLinks).onChange(async (val) => {
        this.plugin.settings.excludeExternalLinks = val;
        await this.plugin.saveSettings();
      }));
      new Setting(containerEl).setName("Exclude Attachments and embeds").setDesc("Prevents masking embedded files ![[]]").addToggle((toggle) => toggle.setValue(this.plugin.settings.excludeEmbeds).onChange(async (val) => {
        this.plugin.settings.excludeEmbeds = val;
        await this.plugin.saveSettings();
      }));
      new Setting(containerEl).setName("Don't revise custom regex").setDesc("Provide a custom regex string to bypass masking (e.g., \\^\\d+ to skip footnotes)").addText((text) => text.setPlaceholder("Enter regex...").setValue(this.plugin.settings.customRegex).onChange(async (val) => {
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
}
