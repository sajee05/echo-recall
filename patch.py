import os

FILE_PATH = r"C:\Users\FO\Documents\GitHub\mains-notes-repo\mains-notes-repo\Mains-Notes\.obsidian\plugins\echo-recall\main.ts"
BACKUP_PATH = FILE_PATH + ".v3.bak"

def patch_echo_recall():
    if not os.path.exists(FILE_PATH):
        print(f"Error: Could not find file at {FILE_PATH}")
        return

    with open(FILE_PATH, "r", encoding="utf-8") as f:
        content = f.read()

    with open(BACKUP_PATH, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"Backup created at: {BACKUP_PATH}")

    # 1. Update processHtmlMedia Signature
    old_sig = "async function processHtmlMedia(app: App, file: TFile, component: Component, markdown: string, ankiSync: boolean = false, depth: number = 0, mediaCache: Set<string> = new Set()): Promise<string> {"
    new_sig = "async function processHtmlMedia(app: App, file: TFile, component: Component, markdown: string, ankiSync: boolean = false, depth: number = 0, mediaCache: Set<string> = new Set(), noteCache: Map<string, string> = new Map()): Promise<string> {"
    content = content.replace(old_sig, new_sig)

    # 2. Add Backlink Cache to prevent repeated rendering of massive linked files
    old_backlink = """if (destFile instanceof TFile && destFile.extension === 'md') {
                const noteContent = await app.vault.read(destFile);
                let cleanContent = noteContent;
                
                const cleanContentMatch = noteContent.match(/^---\\n[\\s\\S]*?\\n---\\n/);
                if (cleanContentMatch) cleanContent = noteContent.slice(cleanContentMatch[0].length);
                
                const linkedNoteHtml = await processHtmlMedia(app, destFile, component, cleanContent.trim(), true, depth + 1, mediaCache);"""
                
    new_backlink = """if (destFile instanceof TFile && destFile.extension === 'md') {
                let linkedNoteHtml = "";
                if (noteCache.has(destFile.path)) {
                    linkedNoteHtml = noteCache.get(destFile.path);
                } else {
                    const noteContent = await app.vault.read(destFile);
                    let cleanContent = noteContent;
                    
                    const cleanContentMatch = noteContent.match(/^---\\n[\\s\\S]*?\\n---\\n/);
                    if (cleanContentMatch) cleanContent = noteContent.slice(cleanContentMatch[0].length);
                    
                    linkedNoteHtml = await processHtmlMedia(app, destFile, component, cleanContent.trim(), true, depth + 1, mediaCache, noteCache);
                    noteCache.set(destFile.path, linkedNoteHtml);
                }"""
    content = content.replace(old_backlink, new_backlink)

    # 3. Add noteCache to Export Initialization
    old_exp_init = """const chunks = generateChunks(body, this.settings.chunkMode);
            const mediaCache = new Set<string>();
            
            exportNotice.noticeEl.innerText = `Echo Recall: Processing full note media...`;
            console.log(`[Echo Recall] Processing full note HTML and media cache...`);
            const fullNoteHtml = await processHtmlMedia(this.app, file, this, body, true, 0, mediaCache);"""
            
    new_exp_init = """const chunks = generateChunks(body, this.settings.chunkMode);
            const mediaCache = new Set<string>();
            const noteCache = new Map<string, string>();
            
            exportNotice.noticeEl.innerText = `Echo Recall: Processing full note media...`;
            console.log(`[Echo Recall] Processing full note HTML and media cache...`);
            const fullNoteHtml = await processHtmlMedia(this.app, file, this, body, true, 0, mediaCache, noteCache);"""
    content = content.replace(old_exp_init, new_exp_init)

    # 4. Pass noteCache to Export loop
    content = content.replace(
        "Content: await processHtmlMedia(this.app, file, this, chunk.content, true, 0, mediaCache),",
        "Content: await processHtmlMedia(this.app, file, this, chunk.content, true, 0, mediaCache, noteCache),"
    )

    # 5. Fix the Crash: Implement BATCH SENDING to Anki
    old_batch = """exportNotice.noticeEl.innerText = `Echo Recall: Sending ${notes.length} notes to Anki...`;
            console.log(`[Echo Recall] Sending ${notes.length} payload(s) to Anki...`);
            const results = await ankiRequest('addNotes', { notes });
            let added = 0; let skipped = 0;
            results.forEach((r: any) => r === null ? skipped++ : added++);"""
            
    new_batch = """exportNotice.noticeEl.innerText = `Echo Recall: Sending ${notes.length} notes to Anki in batches...`;
            console.log(`[Echo Recall] Sending ${notes.length} notes to Anki in batches of 5 to prevent Anki from freezing...`);
            let added = 0; let skipped = 0;
            const BATCH_SIZE = 5;
            for (let i = 0; i < notes.length; i += BATCH_SIZE) {
                const batch = notes.slice(i, i + BATCH_SIZE);
                exportNotice.noticeEl.innerText = `Echo Recall: Sending notes ${i + 1} to ${Math.min(i + BATCH_SIZE, notes.length)} of ${notes.length}...`;
                console.log(`[Echo Recall] Sending batch ${Math.floor(i / BATCH_SIZE) + 1} (notes ${i + 1}-${Math.min(i + BATCH_SIZE, notes.length)})...`);
                
                try {
                    const results = await ankiRequest('addNotes', { notes: batch });
                    results.forEach((r: any) => r === null ? skipped++ : added++);
                } catch (batchErr) {
                    console.error(`[Echo Recall] Batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, batchErr);
                    throw batchErr; 
                }
                
                // 250ms sleep to let Anki's local Python HTTP server breathe
                await new Promise(resolve => setTimeout(resolve, 250));
            }"""
    content = content.replace(old_batch, new_batch)

    # 6. Add noteCache to Update Initialization
    old_upd_init = """const chunks = generateChunks(body, this.settings.chunkMode);
            const mediaCache = new Set<string>();
            
            updateNotice.noticeEl.innerText = `Echo Recall: Fetching updated full note...`;
            const fullNoteHtml = await processHtmlMedia(this.app, file, this, body, true, 0, mediaCache);"""
            
    new_upd_init = """const chunks = generateChunks(body, this.settings.chunkMode);
            const mediaCache = new Set<string>();
            const noteCache = new Map<string, string>();
            
            updateNotice.noticeEl.innerText = `Echo Recall: Fetching updated full note...`;
            const fullNoteHtml = await processHtmlMedia(this.app, file, this, body, true, 0, mediaCache, noteCache);"""
    content = content.replace(old_upd_init, new_upd_init)

    # 7. Pass noteCache to Update loop
    content = content.replace(
        "const newContentHtml = await processHtmlMedia(this.app, file, this, chunk.content, true, 0, mediaCache);",
        "const newContentHtml = await processHtmlMedia(this.app, file, this, chunk.content, true, 0, mediaCache, noteCache);"
    )

    with open(FILE_PATH, "w", encoding="utf-8") as f:
        f.write(content)
        
    print("\n✅ Successfully applied Anki Batching and Backlink Caching logic!")

if __name__ == "__main__":
    patch_echo_recall()