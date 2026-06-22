// OmniJS engine for task attachment operations.
// Invoked via executeOmniFocusScript('@manageAttachments.js', [base64Payload]).
//
// argv[0] is a BASE64-encoded JSON string. Base64 is REQUIRED: the argv
// injection in scriptExecution.ts wraps each arg as "${escapeContent(arg)}",
// and escapeContent does NOT escape double quotes — so a raw JSON arg (or a
// path containing a quote) would break the generated script. The base64
// alphabet (A-Z a-z 0-9 + / =) contains none of " \ ` $, so it passes through
// untouched. Decode with Data.fromBase64(argv[0]).toString().
//
// Payload: { taskId, taskName?, operations: [ {op, ...} ] }
// All file paths are CONTAINER-STAGED paths prepared by the Node primitive —
// OmniFocus is sandboxed and cannot read/write arbitrary user paths, only files
// inside its own container. Operations:
//   { op: "add-embedded",    stagedPath }            // copy bytes into the DB
//   { op: "add-linked",      url }                   // store a file:// reference
//   { op: "remove-embedded", filename }              // match by preferredFilename
//   { op: "remove-linked",   url }
//   { op: "export",          filename, stagedDir }   // write one embedded file out
//   { op: "export",          filename: "all", stagedDir }
(() => {
  function fileURL(p) { return URL.fromString("file://" + encodeURI(p)); }

  function findTask(payload) {
    if (payload.taskId) {
      try { const t = Task.byIdentifier(payload.taskId); if (t) return t; } catch (e) { /* fall through */ }
    }
    if (payload.taskName) {
      const t = flattenedTasks.find(x => x.name === payload.taskName);
      if (t) return t;
    }
    return null;
  }

  // Indices of embedded attachments whose preferredFilename matches `filename`.
  function indicesByName(task, filename) {
    const out = [];
    const atts = task.attachments;
    for (let i = 0; i < atts.length; i++) {
      if (atts[i].preferredFilename === filename) out.push(i);
    }
    return out;
  }

  try {
    if (typeof argv === "undefined" || !argv.length) {
      return JSON.stringify({ success: false, error: "No payload provided" });
    }

    let payload;
    try {
      payload = JSON.parse(Data.fromBase64(argv[0]).toString());
    } catch (e) {
      return JSON.stringify({ success: false, error: "Invalid payload: " + e });
    }

    const task = findTask(payload);
    if (!task) {
      return JSON.stringify({
        success: false,
        error: "Task not found",
        taskId: payload.taskId || null,
        taskName: payload.taskName || null
      });
    }

    const ops = payload.operations || [];
    const results = [];

    for (let k = 0; k < ops.length; k++) {
      const op = ops[k];
      try {
        if (op.op === "add-embedded") {
          const fw = FileWrapper.fromURL(fileURL(op.stagedPath));
          task.addAttachment(fw);
          results.push({ op: op.op, success: true, filename: fw.preferredFilename });

        } else if (op.op === "add-linked") {
          task.addLinkedFileURL(URL.fromString(op.url));
          results.push({ op: op.op, success: true, url: op.url });

        } else if (op.op === "remove-embedded") {
          const idx = indicesByName(task, op.filename);
          if (idx.length === 0) {
            results.push({ op: op.op, success: false, filename: op.filename, error: "No embedded attachment named '" + op.filename + "'" });
          } else if (idx.length > 1) {
            results.push({ op: op.op, success: false, filename: op.filename, error: idx.length + " embedded attachments named '" + op.filename + "' — ambiguous, not removing" });
          } else {
            task.removeAttachmentAtIndex(idx[0]);
            results.push({ op: op.op, success: true, filename: op.filename });
          }

        } else if (op.op === "remove-linked") {
          // Match on the stored URL object, comparing both the clean URL string
          // and the decoded path (the OS may canonicalize, e.g. /tmp ->
          // /private/tmp). Remove via the actual stored object so no string
          // reconstruction is needed.
          const match = task.linkedFileURLs.find(u => u.string === op.url || u.path === op.path);
          if (!match) {
            results.push({ op: op.op, success: false, url: op.url, error: "No linked file matching '" + (op.path || op.url) + "'" });
          } else {
            task.removeLinkedFileWithURL(match);
            results.push({ op: op.op, success: true, url: match.string });
          }

        } else if (op.op === "export") {
          const atts = task.attachments;
          const targets = [];
          if (op.filename === "all") {
            for (let i = 0; i < atts.length; i++) targets.push(atts[i]);
          } else {
            for (let i = 0; i < atts.length; i++) {
              if (atts[i].preferredFilename === op.filename) targets.push(atts[i]);
            }
            if (targets.length === 0) throw new Error("No embedded attachment named '" + op.filename + "'");
          }
          const written = [];
          for (let i = 0; i < targets.length; i++) {
            const a = targets[i];
            const name = a.preferredFilename;
            // Prefix with index to avoid collisions in the staging dir when two
            // embedded attachments share a name; Node strips it on the way out.
            const stagedPath = op.stagedDir + "/" + i + "__" + name;
            a.write(fileURL(stagedPath));
            written.push({ filename: name, stagedPath: stagedPath });
          }
          results.push({ op: op.op, success: true, written: written });

        } else {
          results.push({ op: op.op || "unknown", success: false, error: "Unknown operation" });
        }
      } catch (opErr) {
        results.push({ op: op.op || "unknown", success: false, error: String(opErr) });
      }
    }

    return JSON.stringify({
      success: results.every(r => r.success),
      taskId: task.id.primaryKey,
      taskName: task.name,
      results: results
    });
  } catch (fatal) {
    return JSON.stringify({ success: false, error: "Script error: " + fatal });
  }
})();
