import { useState } from "react";

const DEFAULT_YTDLP = "C:\\ytdlp\\yt-dlp.exe";
const DEFAULT_FFMPEG = "C:\\ytdlp\\ffmpeg.exe";
const DEFAULT_OUTDIR = "C:\\ytdlp\\Output";
const DEFAULT_INDIR = "C:\\Videos";

const INSTALL_BAT_CONTENT = String.raw`@echo off
setlocal enabledelayedexpansion

set "INSTALL_DIR=C:\ytdlp"

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

:: --- yt-dlp ---
if exist "%INSTALL_DIR%\yt-dlp.exe" (
    echo yt-dlp already installed.
) else (
    echo Downloading yt-dlp...
    curl -L -o "%INSTALL_DIR%\yt-dlp.exe" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
)

:: --- ffmpeg ---
if exist "%INSTALL_DIR%\ffmpeg.exe" (
    echo ffmpeg already installed.
) else (
    echo Downloading ffmpeg...
    curl -L -o "%INSTALL_DIR%\ffmpeg.zip" "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"

    echo Extracting ffmpeg...
    powershell -NoProfile -Command "Expand-Archive -Path '%INSTALL_DIR%\ffmpeg.zip' -DestinationPath '%INSTALL_DIR%\ffmpeg_temp' -Force"

    for /d %%D in ("%INSTALL_DIR%\ffmpeg_temp\ffmpeg-*") do (
        copy "%%D\bin\ffmpeg.exe" "%INSTALL_DIR%\" >nul
        copy "%%D\bin\ffprobe.exe" "%INSTALL_DIR%\" >nul
        copy "%%D\bin\ffplay.exe" "%INSTALL_DIR%\" >nul
    )

    rmdir /s /q "%INSTALL_DIR%\ffmpeg_temp"
    del "%INSTALL_DIR%\ffmpeg.zip"
)

:: --- Add to PATH (current user) ---
echo Checking PATH...
echo %PATH% | find /i "%INSTALL_DIR%" >nul
if errorlevel 1 (
    echo Adding %INSTALL_DIR% to user PATH...
    setx PATH "%PATH%;%INSTALL_DIR%"
) else (
    echo %INSTALL_DIR% already in PATH.
)

echo.
echo Done. Verifying installs:
"%INSTALL_DIR%\yt-dlp.exe" --version
"%INSTALL_DIR%\ffmpeg.exe" -version | findstr /b "ffmpeg"

pause`;

const ROTATIONS = [
  { value: "none",  label: "None"    },
  { value: "cw90",  label: "90° CW"  },
  { value: "ccw90", label: "90° CCW" },
  { value: "180",   label: "180°"    },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isYouTubeUrl(url) {
  return /youtu(be\.com|\.be)\//i.test(url);
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim();
}

function isValidTime(t) {
  return !t.trim() || /^\d{1,2}:\d{2}(:\d{2})?$/.test(t.trim());
}

// ffmpeg concat demuxer single-quotes paths; escape any apostrophe as '\''
function concatEscape(name) {
  return name.replace(/'/g, "'\\''");
}

// Turn a local file entry into a batch-ready input reference.
// A bare filename is read from %INDIR%; an absolute path (C:\… or \\server\…)
// is used verbatim so files can be pulled from anywhere.
function toInputRef(name) {
  const n = name.trim();
  if (/^[a-zA-Z]:[\\/]/.test(n) || /^\\\\/.test(n)) return n;
  return `%INDIR%\\${n}`;
}

function downloadText(filename, content) {
  const blob = new Blob([content], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

// Try to pull a "part" marker out of a title.
// Returns { base, part } where base is everything before the marker, or null.
function detectPart(title) {
  if (typeof title !== "string") return null;
  const t = title.trim();
  const patterns = [
    /\b(?:part|pt|p)\s*[._-]?\s*(\d{1,3})\b/gi, // p1, pt 2, part_3
    /[([](\d{1,3})[)\]]/g,                       // (1) [2]
    /\b(\d{1,3})\s*(?:of|\/)\s*\d{1,3}\b/gi,     // 1 of 2, 1/2
  ];
  let best = null;
  for (const re of patterns) {
    let m;
    while ((m = re.exec(t)) !== null) {
      if (!best || m.index >= best.start) {
        best = { start: m.index, end: m.index + m[0].length, num: parseInt(m[1], 10) };
      }
    }
  }
  if (!best) return null;
  const base = t.slice(0, best.start).replace(/[\s._\-|]+$/, "").trim();
  if (!base) return null; // marker but nothing to name it after
  return { base, part: best.num };
}

// Parse text the user pasted back from dump_playlist.bat (or a raw URL list).
function parsePastedList(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  lines.forEach(line => {
    if (line.includes("|||")) {
      const cells = line.split("|||").map(s => s.trim());
      if (cells.length >= 3) {
        out.push({ url: cells[1], title: cells.slice(2).join(" ||| ") || cells[1] });
        return;
      }
      if (cells.length === 2) {
        out.push({ url: cells[0], title: cells[1] });
        return;
      }
    }
    const m = line.match(/https?:\/\/\S+/);
    if (m) {
      const url = m[0];
      const title = line.replace(url, "").replace(/^[\s\d.|:\-]+/, "").trim() || url;
      out.push({ url, title });
      return;
    }
    if (/^[\w-]{6,}$/.test(line)) {
      out.push({ url: `https://youtu.be/${line}`, title: line });
    }
  });
  return out.filter(v => v.url);
}

// Turn parsed videos into editable jobs + items.
function buildInitial(videos) {
  const jobs = [];
  const items = [];
  const keyToJob = new Map();
  let jc = 0, ic = 0;

  videos.forEach(v => {
    const d = detectPart(v.title);
    const key = d
      ? "g:" + d.base.toLowerCase().replace(/\s+/g, " ").trim()
      : "s:" + ic; // singles never merge automatically
    if (!keyToJob.has(key)) {
      const id = "job_" + (jc++);
      keyToJob.set(key, id);
      jobs.push({ id, name: d ? d.base : v.title, excluded: false });
    }
    items.push({
      id: "it_" + (ic++),
      url: v.url,
      title: v.title,
      part: d ? d.part : null,
      jobId: keyToJob.get(key),
    });
  });

  const ordered = [];
  jobs.forEach(j => {
    const its = items.filter(it => it.jobId === j.id);
    its.sort((a, b) => {
      if (a.part != null && b.part != null) return a.part - b.part;
      if (a.part != null) return -1;
      if (b.part != null) return 1;
      return 0;
    });
    ordered.push(...its);
  });

  return { jobs, items: ordered };
}

// ─── Batch generators ────────────────────────────────────────────────────────

// One output's worth of batch lines: download parts, then join / rename / process.
function buildVideoSection({ safe, urls, rotation, trimStart, trimEnd, idx }) {
  const single = urls.length === 1;
  const needsReencode = rotation !== "none";
  const hasTrim       = !!(trimStart?.trim() || trimEnd?.trim());
  const hasProcessing = needsReencode || hasTrim;

  const vfMap = { cw90: "transpose=1", ccw90: "transpose=2", "180": "vflip,hflip" };
  const vfArg     = needsReencode ? `-vf "${vfMap[rotation]}" ` : "";
  const codecArgs = needsReencode ? "-c:v libx264 -c:a aac" : "-c copy";

  let trimArgs = "";
  if (trimStart?.trim()) trimArgs += `-ss ${trimStart.trim()} `;
  if (trimEnd?.trim())   trimArgs += `-to ${trimEnd.trim()} `;

  const header = `REM ===== Video ${idx}: ${safe} (${single ? "single" : urls.length + " parts"}) =====`;
  const dl = urls
    .map((url, i) => `%YTDLP% -f "%FMT%" --merge-output-format mp4 -o "${safe} p${i + 1}.mp4" ${url}`)
    .join("\n");

  let body;
  if (single && !hasProcessing) {
    body =
`echo === Downloading: ${safe} ===
${dl}
echo === Renaming ===
ren "${safe} p1.mp4" "${safe}.mp4"`;
  } else if (single) {
    body =
`echo === Downloading: ${safe} ===
${dl}
echo === Processing: ${safe} ===
%FFMPEG% -i "${safe} p1.mp4" ${trimArgs}${vfArg}${codecArgs} "${safe}.mp4"
del "${safe} p1.mp4"`;
  } else {
    const fileLines = urls.map((_, i) => `echo file '${concatEscape(safe)} p${i + 1}.mp4'`).join("\n");
    const delParts  = urls.map((_, i) => `"${safe} p${i + 1}.mp4"`).join(" ");
    body =
`echo === Downloading ${urls.length} parts: ${safe} ===
${dl}
echo === Joining${hasProcessing ? " and processing" : ""}: ${safe} ===
(
${fileLines}
) > filelist.txt
%FFMPEG% -f concat -safe 0 -i filelist.txt ${trimArgs}${vfArg}${codecArgs} "${safe}.mp4"
del filelist.txt
del ${delParts}`;
  }

  return `${header}\n${body}`;
}

// Local mode — one output's worth of lines for files already on disk.
// Inputs are the user's originals and are NEVER deleted (only the temp
// filelist.txt is removed).
function buildLocalSection({ safe, refs, rotation, trimStart, trimEnd, idx }) {
  const single = refs.length === 1;
  const needsReencode = rotation !== "none";
  const hasTrim       = !!(trimStart?.trim() || trimEnd?.trim());
  const hasProcessing = needsReencode || hasTrim;

  const vfMap = { cw90: "transpose=1", ccw90: "transpose=2", "180": "vflip,hflip" };
  const vfArg     = needsReencode ? `-vf "${vfMap[rotation]}" ` : "";
  const codecArgs = needsReencode ? "-c:v libx264 -c:a aac" : "-c copy";

  let trimArgs = "";
  if (trimStart?.trim()) trimArgs += `-ss ${trimStart.trim()} `;
  if (trimEnd?.trim())   trimArgs += `-to ${trimEnd.trim()} `;

  const header = `REM ===== Output ${idx}: ${safe} (${single ? "1 file" : refs.length + " files joined"}) =====`;

  if (single && !hasProcessing) {
    // Nothing to join or change — just copy the source to the output name/folder.
    return `${header}
echo === Copying: ${safe} ===
copy "${refs[0]}" "${safe}.mp4"`;
  }
  if (single) {
    return `${header}
echo === Processing: ${safe} ===
%FFMPEG% -i "${refs[0]}" ${trimArgs}${vfArg}${codecArgs} "${safe}.mp4"`;
  }
  const fileLines = refs.map(r => `echo file '${concatEscape(r)}'`).join("\n");
  return `${header}
echo === Joining${hasProcessing ? " and processing" : ""} ${refs.length} files: ${safe} ===
(
${fileLines}
) > filelist.txt
%FFMPEG% -f concat -safe 0 -i filelist.txt ${trimArgs}${vfArg}${codecArgs} "${safe}.mp4"
del filelist.txt`;
}

// Links mode — one or many videos, each downloaded and joined into its own file.
function generateLinksBatch({ groups, ytdlp, ffmpeg, outdir, rotation, trimStart, trimEnd }) {
  const complete = groups
    .map(g => ({ safe: sanitizeFilename(g.name) || "output", urls: g.urls.filter(u => u.trim()) }))
    .filter(g => g.urls.length > 0);

  const blocks = complete
    .map((g, i) => buildVideoSection({ safe: g.safe, urls: g.urls, rotation, trimStart, trimEnd, idx: i + 1 }))
    .join("\n\n");

  const footer = complete.length === 1
    ? `echo.\necho Done! Output: ${complete[0].safe}.mp4\npause`
    : `echo.\necho All done! ${complete.length} file(s) created in "%OUTDIR%".\npause`;

  return `@echo off
setlocal

set YTDLP=${ytdlp}
set FFMPEG=${ffmpeg}
set OUTDIR=${outdir}

if not exist "%OUTDIR%" mkdir "%OUTDIR%"
cd /d "%OUTDIR%"

set FMT=bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b

${blocks}

${footer}
`;
}

// Local mode — process files already on the machine (join / rotate / trim).
function generateLocalBatch({ groups, ffmpeg, indir, outdir, rotation, trimStart, trimEnd }) {
  const complete = groups
    .map(g => ({
      safe: sanitizeFilename(g.name) || "output",
      refs: g.files.map(f => f.trim()).filter(Boolean).map(f => toInputRef(f)),
    }))
    .filter(g => g.refs.length > 0);

  const blocks = complete
    .map((g, i) => buildLocalSection({ safe: g.safe, refs: g.refs, rotation, trimStart, trimEnd, idx: i + 1 }))
    .join("\n\n");

  const footer = complete.length === 1
    ? `echo.\necho Done! Output: ${complete[0].safe}.mp4\npause`
    : `echo.\necho All done! ${complete.length} file(s) created in "%OUTDIR%".\npause`;

  return `@echo off
setlocal

set FFMPEG=${ffmpeg}
set INDIR=${indir}
set OUTDIR=${outdir}

if not exist "%OUTDIR%" mkdir "%OUTDIR%"
cd /d "%OUTDIR%"

REM Source files are read from %INDIR% and never modified or deleted.

${blocks}

${footer}
`;
}

// Playlist step 1 — list the playlist's videos into playlist.txt
function generateDumpBat({ playlistUrl, ytdlp }) {
  return `@echo off
setlocal

set YTDLP=${ytdlp}
set "PLAYLIST=${playlistUrl}"

echo Fetching playlist video list...
%YTDLP% --flat-playlist --print "%%(playlist_index)s ||| %%(url)s ||| %%(title)s" "%PLAYLIST%" > playlist.txt

echo.
echo Done. Open playlist.txt, copy everything, and paste it back into Joinr.
pause
`;
}

// Playlist step 2 — one script, every job downloaded and joined in turn.
function generateJoinBat({ jobs, items, ytdlp, ffmpeg, outdir }) {
  const active = jobs
    .filter(j => !j.excluded)
    .map(j => ({ name: j.name, items: items.filter(it => it.jobId === j.id) }))
    .filter(j => j.items.length > 0);

  const blocks = active.map((job, ji) => {
    const safe = sanitizeFilename(job.name) || `output_${ji + 1}`;
    const single = job.items.length === 1;
    const header = `REM ===== Job ${ji + 1}: ${safe} (${single ? "single" : job.items.length + " parts"}) =====`;

    if (single) {
      return `${header}
echo === Downloading: ${safe} ===
%YTDLP% -f "%FMT%" --merge-output-format mp4 -o "${safe}.mp4" ${job.items[0].url}`;
    }

    const dl = job.items
      .map((it, i) => `%YTDLP% -f "%FMT%" --merge-output-format mp4 -o "${safe} p${i + 1}.mp4" ${it.url}`)
      .join("\n");
    const fileLines = job.items.map((_, i) => `echo file '${concatEscape(safe)} p${i + 1}.mp4'`).join("\n");
    const delParts  = job.items.map((_, i) => `"${safe} p${i + 1}.mp4"`).join(" ");

    return `${header}
echo === Downloading ${job.items.length} parts: ${safe} ===
${dl}
echo === Joining: ${safe} ===
(
${fileLines}
) > filelist.txt
%FFMPEG% -f concat -safe 0 -i filelist.txt -c copy "${safe}.mp4"
del filelist.txt
del ${delParts}`;
  }).join("\n\n");

  return `@echo off
setlocal

set YTDLP=${ytdlp}
set FFMPEG=${ffmpeg}
set OUTDIR=${outdir}

if not exist "%OUTDIR%" mkdir "%OUTDIR%"
cd /d "%OUTDIR%"

set FMT=bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b

${blocks}

echo.
echo All done! ${active.length} file(s) created in "%OUTDIR%".
pause
`;
}

// ─── Shared UI bits ───────────────────────────────────────────────────────────

const sectionLabel = {
  fontSize: 12, fontWeight: 600, color: "#374151",
  textTransform: "uppercase", letterSpacing: "0.06em", display: "block",
};

function OutputPanel({ filename, content }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  return (
    <div style={{ marginTop: 20, background: "#0f172a", borderRadius: 16, border: "1px solid #1e293b", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #1e293b" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {filename}
        </span>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <button
            onClick={copy}
            style={{ padding: "5px 12px", fontSize: 12, borderRadius: 6, border: "1px solid #334155", background: "#1e293b", color: copied ? "#4ade80" : "#94a3b8", cursor: "pointer", fontWeight: 600 }}
          >{copied ? "✓ Copied" : "Copy"}</button>
          <button
            onClick={() => downloadText(filename, content)}
            style={{ padding: "5px 12px", fontSize: 12, borderRadius: 6, border: "none", background: "linear-gradient(135deg, #6366f1, #818cf8)", color: "#fff", cursor: "pointer", fontWeight: 700 }}
          >⬇ Download .bat</button>
        </div>
      </div>
      <pre style={{ margin: 0, padding: 16, fontSize: 11, fontFamily: "monospace", color: "#94a3b8", overflowX: "auto", lineHeight: 1.6, maxHeight: 320, overflowY: "auto", whiteSpace: "pre" }}>
        {content}
      </pre>
    </div>
  );
}

function UrlRow({ index, value, onChange, onRemove, canRemove, placeholder = "https://youtu.be/…", validate = isYouTubeUrl }) {
  const invalid = value && !validate(value);
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", minWidth: 24, textAlign: "right", fontFamily: "monospace" }}>
        {index + 1}
      </span>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          flex: 1, padding: "9px 12px", fontSize: 13, fontFamily: "monospace",
          border: "1.5px solid",
          borderColor: invalid ? "#f87171" : "#d1d5db",
          borderRadius: 8, outline: "none", background: "#fafafa",
          transition: "border-color 0.15s", color: "#111",
        }}
      />
      {canRemove && (
        <button
          onClick={onRemove}
          title="Remove"
          style={{ width: 30, height: 30, borderRadius: 6, border: "none", background: "#fee2e2", color: "#dc2626", cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
        >×</button>
      )}
    </div>
  );
}

function TimeInput({ label, value, onChange, placeholder }) {
  const invalid = value && !isValidTime(value);
  return (
    <div style={{ flex: 1 }}>
      <span style={{ fontSize: 10.5, color: "#9ca3af", display: "block", marginBottom: 4 }}>{label}</span>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%", boxSizing: "border-box", padding: "9px 12px", fontSize: 13, fontFamily: "monospace",
          border: "1.5px solid", borderColor: invalid ? "#f87171" : "#d1d5db",
          borderRadius: 8, outline: "none", background: "#fff", color: "#111", transition: "border-color 0.15s",
        }}
      />
    </div>
  );
}

// Rotation + trim controls, shared by Links and Local modes.
function TransformPanel({ rotation, setRotation, trimStart, setTrimStart, trimEnd, setTrimEnd, onChange, multi }) {
  const timesValid = isValidTime(trimStart) && isValidTime(trimEnd);
  return (
    <div style={{ marginBottom: 16, padding: "14px 16px", background: "#f8fafc", borderRadius: 10, border: "1px solid #e5e7eb" }}>
      <span style={{ ...sectionLabel, marginBottom: multi ? 8 : 14 }}>Transform</span>
      {multi && (
        <p style={{ margin: "0 0 14px", fontSize: 11, color: "#9ca3af", lineHeight: 1.5 }}>
          With multiple videos, rotation and trim are applied to every output. Leave blank for a plain join.
        </p>
      )}
      <div style={{ marginBottom: 16 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", display: "block", marginBottom: 8 }}>Rotation</span>
        <div style={{ display: "flex", gap: 6 }}>
          {ROTATIONS.map(opt => {
            const active = rotation === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => { setRotation(opt.value); onChange(); }}
                style={{ flex: 1, padding: "7px 0", fontSize: 12.5, fontWeight: 600, borderRadius: 7, border: "1.5px solid", borderColor: active ? "#6366f1" : "#d1d5db", background: active ? "#eef2ff" : "#fff", color: active ? "#4338ca" : "#6b7280", cursor: "pointer", transition: "all 0.12s" }}
              >{opt.label}</button>
            );
          })}
        </div>
        {rotation !== "none" && (
          <p style={{ margin: "7px 0 0", fontSize: 11, color: "#7c3aed" }}>⚠ Re-encodes with libx264 — slower than stream copy</p>
        )}
      </div>
      <div>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", display: "block", marginBottom: 8 }}>
          Trim <span style={{ fontWeight: 400 }}>— leave blank to keep full length</span>
        </span>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          <TimeInput label="Start time" value={trimStart} onChange={v => { setTrimStart(v); onChange(); }} placeholder="0:30" />
          <span style={{ color: "#d1d5db", paddingBottom: 11, fontSize: 18 }}>→</span>
          <TimeInput label="End time" value={trimEnd} onChange={v => { setTrimEnd(v); onChange(); }} placeholder="1:45:00" />
        </div>
        {(trimStart || trimEnd) && !timesValid && (
          <p style={{ margin: "7px 0 0", fontSize: 11, color: "#f87171" }}>Use M:SS or H:MM:SS (e.g. 1:30 or 0:01:30)</p>
        )}
        {(trimStart || trimEnd) && timesValid && rotation === "none" && (
          <p style={{ margin: "7px 0 0", fontSize: 11, color: "#6b7280" }}>Trim without rotation uses stream copy — cuts at nearest keyframe</p>
        )}
      </div>
    </div>
  );
}

// One video in Links mode: its own output name + ordered parts.
function LinksVideo({ group, index, canRemove, onName, onUrl, onAddUrl, onRemoveUrl, onRemove }) {
  const filled = group.urls.filter(u => u.trim());
  const safe = sanitizeFilename(group.name) || "output";
  const parts = filled.length;
  return (
    <div style={{ padding: "14px 16px", borderRadius: 10, border: "1px solid #e5e7eb", background: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Video {index + 1}{parts > 1 ? ` · ${parts} parts` : ""}
        </span>
        {canRemove && (
          <button
            onClick={onRemove}
            title="Remove this video"
            style={{ border: "none", background: "#fee2e2", color: "#dc2626", borderRadius: 6, fontSize: 11, fontWeight: 600, padding: "4px 9px", cursor: "pointer" }}
          >Remove video</button>
        )}
      </div>

      <input
        type="text"
        value={group.name}
        onChange={e => onName(e.target.value)}
        placeholder="Output filename — e.g. Enis Yuda top v Dorel Leon hr1 15pt"
        style={{ display: "block", width: "100%", boxSizing: "border-box", padding: "9px 12px", fontSize: 13.5, border: "1.5px solid #d1d5db", borderRadius: 8, outline: "none", background: "#fafafa", color: "#111", marginBottom: group.name ? 4 : 12 }}
      />
      {group.name && (
        <span style={{ fontSize: 11, color: "#6b7280", marginBottom: 12, display: "block" }}>→ {safe}.mp4</span>
      )}

      <span style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", display: "block", marginBottom: 8 }}>
        YouTube links{" "}
        <span style={{ fontWeight: 400 }}>{parts <= 1 ? "(single video works fine)" : "(in order)"}</span>
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {group.urls.map((url, i) => (
          <UrlRow key={i} index={i} value={url} onChange={v => onUrl(i, v)} onRemove={() => onRemoveUrl(i)} canRemove={group.urls.length > 1} />
        ))}
      </div>
      <button
        onClick={onAddUrl}
        style={{ marginTop: 10, padding: "7px 14px", fontSize: 12.5, border: "1.5px dashed #c4b5fd", borderRadius: 8, background: "#faf5ff", color: "#7c3aed", cursor: "pointer", fontWeight: 600, width: "100%" }}
      >+ Add another part</button>
    </div>
  );
}

// One video in Local mode: its own output name + ordered source files on disk.
function LocalVideo({ group, index, canRemove, onName, onFile, onAddFile, onRemoveFile, onRemove }) {
  const filled = group.files.filter(f => f.trim());
  const safe = sanitizeFilename(group.name) || "output";
  const count = filled.length;
  return (
    <div style={{ padding: "14px 16px", borderRadius: 10, border: "1px solid #e5e7eb", background: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Video {index + 1}{count > 1 ? ` · ${count} files` : ""}
        </span>
        {canRemove && (
          <button
            onClick={onRemove}
            title="Remove this video"
            style={{ border: "none", background: "#fee2e2", color: "#dc2626", borderRadius: 6, fontSize: 11, fontWeight: 600, padding: "4px 9px", cursor: "pointer" }}
          >Remove video</button>
        )}
      </div>

      <input
        type="text"
        value={group.name}
        onChange={e => onName(e.target.value)}
        placeholder="Output filename — e.g. Full match joined"
        style={{ display: "block", width: "100%", boxSizing: "border-box", padding: "9px 12px", fontSize: 13.5, border: "1.5px solid #d1d5db", borderRadius: 8, outline: "none", background: "#fafafa", color: "#111", marginBottom: group.name ? 4 : 12 }}
      />
      {group.name && (
        <span style={{ fontSize: 11, color: "#6b7280", marginBottom: 12, display: "block" }}>→ {safe}.mp4</span>
      )}

      <span style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", display: "block", marginBottom: 8 }}>
        Source files{" "}
        <span style={{ fontWeight: 400 }}>{count <= 1 ? "(single file works fine)" : "(in order)"}</span>
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {group.files.map((file, i) => (
          <UrlRow
            key={i}
            index={i}
            value={file}
            onChange={v => onFile(i, v)}
            onRemove={() => onRemoveFile(i)}
            canRemove={group.files.length > 1}
            placeholder="match part 1.mp4   (or a full path)"
            validate={() => true}
          />
        ))}
      </div>
      <button
        onClick={onAddFile}
        style={{ marginTop: 10, padding: "7px 14px", fontSize: 12.5, border: "1.5px dashed #c4b5fd", borderRadius: 8, background: "#faf5ff", color: "#7c3aed", cursor: "pointer", fontWeight: 600, width: "100%" }}
      >+ Add another file</button>
    </div>
  );
}

// One match = one output file, with its ordered parts (Playlist mode).
function JobCard({ job, jobs, items, onRename, onToggle, onMoveItem, onReassign, onRemoveItem }) {
  const myItems = items.filter(it => it.jobId === job.id);
  const safe = sanitizeFilename(job.name) || "output";
  const single = myItems.length === 1;

  return (
    <div style={{ padding: "12px 14px", borderRadius: 10, border: "1px solid #e5e7eb", background: job.excluded ? "#f3f4f6" : "#fff", opacity: job.excluded ? 0.6 : 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: myItems.length ? 10 : 0 }}>
        <input type="checkbox" checked={!job.excluded} onChange={onToggle} title={job.excluded ? "Include this match" : "Skip this match"} style={{ width: 16, height: 16, cursor: "pointer", flexShrink: 0 }} />
        <input type="text" value={job.name} onChange={e => onRename(e.target.value)} placeholder="Output name" style={{ flex: 1, padding: "7px 10px", fontSize: 13, fontWeight: 600, border: "1.5px solid #d1d5db", borderRadius: 7, outline: "none", background: "#fafafa", color: "#111", minWidth: 0 }} />
        <span style={{ fontSize: 10.5, fontWeight: 700, color: single ? "#0369a1" : "#4338ca", background: single ? "#e0f2fe" : "#eef2ff", padding: "3px 8px", borderRadius: 6, whiteSpace: "nowrap", flexShrink: 0 }}>
          {single ? "single" : `${myItems.length} parts`}
        </span>
      </div>

      {myItems.length === 0 ? (
        <p style={{ margin: 0, fontSize: 11.5, color: "#9ca3af", fontStyle: "italic" }}>
          Empty — reassign parts here, or it will be skipped.
        </p>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {myItems.map((it, i) => (
              <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 1, flexShrink: 0 }}>
                  <button onClick={() => onMoveItem(it.id, -1)} disabled={i === 0} title="Move up" style={{ width: 20, height: 14, lineHeight: "10px", fontSize: 9, border: "1px solid #e5e7eb", borderRadius: "4px 4px 0 0", background: i === 0 ? "#f9fafb" : "#fff", color: i === 0 ? "#d1d5db" : "#6b7280", cursor: i === 0 ? "default" : "pointer", padding: 0 }}>▲</button>
                  <button onClick={() => onMoveItem(it.id, 1)} disabled={i === myItems.length - 1} title="Move down" style={{ width: 20, height: 14, lineHeight: "10px", fontSize: 9, border: "1px solid #e5e7eb", borderTop: "none", borderRadius: "0 0 4px 4px", background: i === myItems.length - 1 ? "#f9fafb" : "#fff", color: i === myItems.length - 1 ? "#d1d5db" : "#6b7280", cursor: i === myItems.length - 1 ? "default" : "pointer", padding: 0 }}>▼</button>
                </div>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: "#9ca3af", fontFamily: "monospace", minWidth: 20, textAlign: "right", flexShrink: 0 }}>p{i + 1}</span>
                <span title={it.title} style={{ flex: 1, fontSize: 12, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{it.title}</span>
                <select value={it.jobId} onChange={e => onReassign(it.id, e.target.value)} title="Move to another match" style={{ fontSize: 11, padding: "3px 4px", border: "1px solid #e5e7eb", borderRadius: 6, background: "#fff", color: "#6b7280", cursor: "pointer", maxWidth: 110, flexShrink: 0 }}>
                  {jobs.map(j => (
                    <option key={j.id} value={j.id}>{(sanitizeFilename(j.name) || "output").slice(0, 30)}</option>
                  ))}
                </select>
                <button onClick={() => onRemoveItem(it.id)} title="Remove this video" style={{ width: 24, height: 24, borderRadius: 5, border: "none", background: "#fee2e2", color: "#dc2626", cursor: "pointer", fontSize: 14, flexShrink: 0 }}>×</button>
              </div>
            ))}
          </div>
          <span style={{ fontSize: 11, color: "#6b7280", marginTop: 8, display: "block" }}>→ {safe}.mp4</span>
        </>
      )}
    </div>
  );
}

// ─── App ────────────────────────────────────────────────────────────────────

let groupSeq = 1;
const newGroup = () => ({ id: "g" + (groupSeq++), name: "", urls: ["", ""] });

let localSeq = 1;
const newLocalGroup = () => ({ id: "l" + (localSeq++), name: "", files: ["", ""] });

export default function App() {
  const [mode, setMode] = useState("links");

  // Shared
  const [ytdlp, setYtdlp]   = useState(DEFAULT_YTDLP);
  const [ffmpeg, setFfmpeg] = useState(DEFAULT_FFMPEG);
  const [outdir, setOutdir] = useState(DEFAULT_OUTDIR);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Links mode — a list of videos, each with its own name + parts
  const [groups, setGroups]       = useState([newGroup()]);
  const [rotation, setRotation]   = useState("none");
  const [trimStart, setTrimStart] = useState("");
  const [trimEnd, setTrimEnd]     = useState("");
  const [linksBat, setLinksBat]   = useState(null);

  // Local mode — files already on the machine
  const [indir, setIndir]                   = useState(DEFAULT_INDIR);
  const [localGroups, setLocalGroups]       = useState([newLocalGroup()]);
  const [localRotation, setLocalRotation]   = useState("none");
  const [localTrimStart, setLocalTrimStart] = useState("");
  const [localTrimEnd, setLocalTrimEnd]     = useState("");
  const [localBat, setLocalBat]             = useState(null);

  // Playlist mode
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [dumpBat, setDumpBat]         = useState(null);
  const [pasted, setPasted]           = useState("");
  const [jobs, setJobs]               = useState([]);
  const [items, setItems]             = useState([]);
  const [parsed, setParsed]           = useState(false);
  const [joinBat, setJoinBat]         = useState(null);

  // ── Links handlers ──
  const invalidateLinks = () => setLinksBat(null);
  const setGroupName   = (gid, name)   => { setGroups(p => p.map(g => g.id === gid ? { ...g, name } : g)); invalidateLinks(); };
  const setGroupUrl    = (gid, i, val) => { setGroups(p => p.map(g => g.id === gid ? { ...g, urls: g.urls.map((u, j) => j === i ? val : u) } : g)); invalidateLinks(); };
  const addGroupUrl    = (gid)         => { setGroups(p => p.map(g => g.id === gid ? { ...g, urls: [...g.urls, ""] } : g)); invalidateLinks(); };
  const removeGroupUrl = (gid, i)      => { setGroups(p => p.map(g => g.id === gid ? { ...g, urls: g.urls.filter((_, j) => j !== i) } : g)); invalidateLinks(); };
  const addGroup       = ()            => { setGroups(p => [...p, newGroup()]); invalidateLinks(); };
  const removeGroup    = (gid)         => { setGroups(p => p.filter(g => g.id !== gid)); invalidateLinks(); };

  const statuses = groups.map(g => {
    const filled = g.urls.filter(u => u.trim());
    const empty = !g.name.trim() && filled.length === 0;
    const complete = !!g.name.trim() && filled.length >= 1 && filled.every(isYouTubeUrl);
    return { empty, complete };
  });
  const completeCount = statuses.filter(s => s.complete).length;
  const anyIncomplete = statuses.some(s => !s.empty && !s.complete);
  const timesValid    = isValidTime(trimStart) && isValidTime(trimEnd);
  const canGenerate   = completeCount >= 1 && !anyIncomplete && timesValid;
  const multi         = groups.length > 1;

  const firstCompleteIdx = statuses.findIndex(s => s.complete);
  const linksFilename = completeCount === 1 && firstCompleteIdx >= 0
    ? `${sanitizeFilename(groups[firstCompleteIdx].name) || "output"}_download_join.bat`
    : "batch_download_join.bat";

  const handleGenerate = () =>
    setLinksBat(generateLinksBatch({ groups, ytdlp, ffmpeg, outdir, rotation, trimStart, trimEnd }));

  const linksHint =
    completeCount === 0 ? "Each video needs a name and at least one valid YouTube URL" :
    anyIncomplete       ? "Finish or remove the incomplete video (needs a name + valid links)" :
    !timesValid         ? "Fix time format (M:SS or H:MM:SS)" : "";

  // ── Local handlers ──
  const invalidateLocal = () => setLocalBat(null);
  const setLocalName    = (id, name)   => { setLocalGroups(p => p.map(g => g.id === id ? { ...g, name } : g)); invalidateLocal(); };
  const setLocalFile    = (id, i, val) => { setLocalGroups(p => p.map(g => g.id === id ? { ...g, files: g.files.map((f, j) => j === i ? val : f) } : g)); invalidateLocal(); };
  const addLocalFile    = (id)         => { setLocalGroups(p => p.map(g => g.id === id ? { ...g, files: [...g.files, ""] } : g)); invalidateLocal(); };
  const removeLocalFile = (id, i)      => { setLocalGroups(p => p.map(g => g.id === id ? { ...g, files: g.files.filter((_, j) => j !== i) } : g)); invalidateLocal(); };
  const addLocalGroup   = ()           => { setLocalGroups(p => [...p, newLocalGroup()]); invalidateLocal(); };
  const removeLocalGroup = (id)        => { setLocalGroups(p => p.filter(g => g.id !== id)); invalidateLocal(); };

  const localStatuses = localGroups.map(g => {
    const filled = g.files.filter(f => f.trim());
    const empty = !g.name.trim() && filled.length === 0;
    const complete = !!g.name.trim() && filled.length >= 1;
    return { empty, complete };
  });
  const localCompleteCount = localStatuses.filter(s => s.complete).length;
  const localAnyIncomplete = localStatuses.some(s => !s.empty && !s.complete);
  const localTimesValid    = isValidTime(localTrimStart) && isValidTime(localTrimEnd);
  const localCanGenerate   = localCompleteCount >= 1 && !localAnyIncomplete && localTimesValid && !!indir.trim();
  const localMulti         = localGroups.length > 1;

  const firstLocalCompleteIdx = localStatuses.findIndex(s => s.complete);
  const localFilename = localCompleteCount === 1 && firstLocalCompleteIdx >= 0
    ? `${sanitizeFilename(localGroups[firstLocalCompleteIdx].name) || "output"}_join.bat`
    : "batch_join_local.bat";

  const handleGenerateLocal = () =>
    setLocalBat(generateLocalBatch({ groups: localGroups, ffmpeg, indir, outdir, rotation: localRotation, trimStart: localTrimStart, trimEnd: localTrimEnd }));

  const sameFolder =
    indir.trim() && outdir.trim() &&
    indir.trim().replace(/[\\/]+$/, "").toLowerCase() === outdir.trim().replace(/[\\/]+$/, "").toLowerCase();

  const localHint =
    localCompleteCount === 0 ? "Each video needs a name and at least one source file" :
    localAnyIncomplete       ? "Finish or remove the incomplete video (needs a name + at least one file)" :
    !indir.trim()            ? "Set the folder containing your videos" :
    !localTimesValid         ? "Fix time format (M:SS or H:MM:SS)" : "";

  // ── Playlist handlers ──
  const invalidateJoin = () => setJoinBat(null);
  const handleGenerateDump = () => setDumpBat(generateDumpBat({ playlistUrl: playlistUrl.trim(), ytdlp }));
  const handleParse = () => {
    const videos = parsePastedList(pasted);
    const built = buildInitial(videos);
    setJobs(built.jobs);
    setItems(built.items);
    setParsed(true);
    setJoinBat(null);
  };
  const renameJob    = (id, name)  => { setJobs(p => p.map(j => j.id === id ? { ...j, name } : j)); invalidateJoin(); };
  const toggleJob    = (id)        => { setJobs(p => p.map(j => j.id === id ? { ...j, excluded: !j.excluded } : j)); invalidateJoin(); };
  const reassignItem = (id, jobId) => { setItems(p => p.map(it => it.id === id ? { ...it, jobId } : it)); invalidateJoin(); };
  const removeItem   = (id)        => { setItems(p => p.filter(it => it.id !== id)); invalidateJoin(); };
  const addJob       = ()          => { setJobs(p => [...p, { id: "job_" + Date.now(), name: "New group", excluded: false }]); };
  const moveItem = (id, dir) => {
    setItems(prev => {
      const arr = [...prev];
      const i = arr.findIndex(x => x.id === id);
      if (i < 0) return prev;
      const jobId = arr[i].jobId;
      let j = i + dir;
      while (j >= 0 && j < arr.length && arr[j].jobId !== jobId) j += dir;
      if (j < 0 || j >= arr.length) return prev;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return arr;
    });
    invalidateJoin();
  };
  const activeJobs = jobs.filter(j => !j.excluded && items.some(it => it.jobId === j.id));
  const totalParts = items.filter(it => activeJobs.some(j => j.id === it.jobId)).length;
  const handleGenerateJoin = () => setJoinBat(generateJoinBat({ jobs, items, ytdlp, ffmpeg, outdir }));

  // ── Shared building blocks ──
  const modeButton = (val, label) => {
    const active = mode === val;
    return (
      <button
        onClick={() => setMode(val)}
        style={{ flex: 1, padding: "8px 0", fontSize: 13, fontWeight: 700, cursor: "pointer", border: "none", borderRadius: 8, background: active ? "linear-gradient(135deg, #6366f1, #818cf8)" : "transparent", color: active ? "#fff" : "#94a3b8", transition: "all 0.15s" }}
      >{label}</button>
    );
  };

  const pathRows = mode === "local"
    ? [["ffmpeg path", ffmpeg, setFfmpeg], ["Output folder", outdir, setOutdir]]
    : [["yt-dlp path", ytdlp, setYtdlp], ["ffmpeg path", ffmpeg, setFfmpeg], ["Output folder", outdir, setOutdir]];
  const pathsLabel = mode === "local"
    ? "Paths (ffmpeg, output folder)"
    : "Paths (yt-dlp, ffmpeg, output folder)";

  const pathsAdvanced = (
    <div style={{ marginBottom: 20 }}>
      <button
        onClick={() => setShowAdvanced(a => !a)}
        style={{ background: "none", border: "none", padding: 0, fontSize: 12, color: "#6b7280", cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}
      >
        <span style={{ transform: showAdvanced ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform 0.15s" }}>▶</span>
        {pathsLabel}
      </button>
      {showAdvanced && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          {pathRows.map(([label, val, setter]) => (
            <label key={label} style={{ display: "block" }}>
              <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 600 }}>{label}</span>
              <input
                type="text"
                value={val}
                onChange={e => { setter(e.target.value); invalidateLinks(); invalidateJoin(); invalidateLocal(); }}
                style={{ display: "block", width: "100%", marginTop: 4, padding: "7px 10px", fontSize: 12, boxSizing: "border-box", fontFamily: "monospace", border: "1.5px solid #e5e7eb", borderRadius: 6, background: "#f9fafb", color: "#374151", outline: "none" }}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      padding: "40px 16px", fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      <div style={{ width: "100%", maxWidth: 560 }}>

        {/* Header */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg, #6366f1, #818cf8)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>▶</div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.3px" }}>Joinr</h1>
          </div>
          <p style={{ margin: 0, color: "#94a3b8", fontSize: 13.5 }}>
            Paste YouTube links — or point at files on your machine — and get a .bat that joins, rotates, or trims them.
          </p>
        </div>

        {/* Mode switch */}
        <div style={{ display: "flex", gap: 4, padding: 4, marginBottom: 16, background: "rgba(15,23,42,0.6)", border: "1px solid #1e293b", borderRadius: 12 }}>
          {modeButton("links", "Links")}
          {modeButton("playlist", "Playlist")}
          {modeButton("local", "Local files")}
        </div>

        {/* First-time setup banner */}
        <div style={{ marginBottom: 16, padding: "14px 16px", background: "rgba(99, 102, 241, 0.08)", border: "1px solid rgba(99, 102, 241, 0.25)", borderRadius: 12, display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ fontSize: 22, flexShrink: 0 }}>🔧</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", display: "block", marginBottom: 3 }}>
              {mode === "local"
                ? "Local files only need ffmpeg"
                : "First time? Install yt-dlp \u0026 ffmpeg first"}
            </span>
            <span style={{ fontSize: 11.5, color: "#64748b", lineHeight: 1.5 }}>
              Download and run{" "}
              <code style={{ color: "#a5b4fc", background: "rgba(99,102,241,0.15)", padding: "1px 5px", borderRadius: 4, fontSize: 11 }}>install_ytdlp.bat</code>
              {" "}once — it auto-downloads both tools and adds them to your PATH.
            </span>
          </div>
          <button
            onClick={() => downloadText("install_ytdlp.bat", INSTALL_BAT_CONTENT)}
            style={{ padding: "8px 13px", fontSize: 12, fontWeight: 700, flexShrink: 0, borderRadius: 8, border: "1px solid rgba(99, 102, 241, 0.4)", background: "rgba(99, 102, 241, 0.15)", color: "#a5b4fc", cursor: "pointer", whiteSpace: "nowrap" }}
          >⬇ install_ytdlp.bat</button>
        </div>

        {/* ─── LINKS MODE ─── */}
        {mode === "links" && (
          <>
            <div style={{ background: "#fff", borderRadius: 16, padding: 28, boxShadow: "0 4px 32px rgba(0,0,0,0.25)" }}>

              <div style={{ marginBottom: 16 }}>
                <span style={{ ...sectionLabel, marginBottom: 4 }}>Videos</span>
                <p style={{ margin: "0 0 12px", fontSize: 12, color: "#9ca3af", lineHeight: 1.5 }}>
                  Each video below becomes its own file. Add parts within a video to join them; add more videos to make several files in one run.
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {groups.map((g, i) => (
                    <LinksVideo
                      key={g.id}
                      group={g}
                      index={i}
                      canRemove={groups.length > 1}
                      onName={name => setGroupName(g.id, name)}
                      onUrl={(j, v) => setGroupUrl(g.id, j, v)}
                      onAddUrl={() => addGroupUrl(g.id)}
                      onRemoveUrl={j => removeGroupUrl(g.id, j)}
                      onRemove={() => removeGroup(g.id)}
                    />
                  ))}
                </div>
                <button
                  onClick={addGroup}
                  style={{ marginTop: 12, padding: "9px 14px", fontSize: 13, border: "1.5px solid #c4b5fd", borderRadius: 8, background: "#f5f3ff", color: "#6d28d9", cursor: "pointer", fontWeight: 700, width: "100%" }}
                >+ Add another video</button>
              </div>

              <TransformPanel
                rotation={rotation} setRotation={setRotation}
                trimStart={trimStart} setTrimStart={setTrimStart}
                trimEnd={trimEnd} setTrimEnd={setTrimEnd}
                onChange={invalidateLinks} multi={multi}
              />

              {pathsAdvanced}

              <button
                onClick={handleGenerate}
                disabled={!canGenerate}
                style={{ width: "100%", padding: "11px 0", fontSize: 14, fontWeight: 700, borderRadius: 10, border: "none", cursor: canGenerate ? "pointer" : "not-allowed", background: canGenerate ? "linear-gradient(135deg, #6366f1, #818cf8)" : "#e5e7eb", color: canGenerate ? "#fff" : "#9ca3af", transition: "opacity 0.15s" }}
              >
                {canGenerate && completeCount > 1 ? `Generate script (${completeCount} files)` : "Generate script"}
              </button>
              {!canGenerate && (
                <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "#9ca3af", textAlign: "center" }}>{linksHint}</p>
              )}
            </div>

            {linksBat && <OutputPanel filename={linksFilename} content={linksBat} />}
          </>
        )}

        {/* ─── LOCAL MODE ─── */}
        {mode === "local" && (
          <>
            <div style={{ background: "#fff", borderRadius: 16, padding: 28, boxShadow: "0 4px 32px rgba(0,0,0,0.25)" }}>

              {/* Input folder */}
              <div style={{ marginBottom: 20 }}>
                <span style={{ ...sectionLabel, marginBottom: 6 }}>Folder containing your videos</span>
                <p style={{ margin: "0 0 10px", fontSize: 12, color: "#9ca3af", lineHeight: 1.5 }}>
                  The folder your source files already live in. Below, list each file by name — or paste a full path to pull a file from anywhere.
                </p>
                <input
                  type="text"
                  value={indir}
                  onChange={e => { setIndir(e.target.value); invalidateLocal(); }}
                  placeholder="C:\Videos"
                  style={{ display: "block", width: "100%", boxSizing: "border-box", padding: "9px 12px", fontSize: 13, fontFamily: "monospace", border: "1.5px solid #d1d5db", borderRadius: 8, outline: "none", background: "#fafafa", color: "#111" }}
                />
                {sameFolder && (
                  <p style={{ margin: "7px 0 0", fontSize: 11, color: "#6b7280" }}>
                    Output folder is the same as this one — results land alongside your originals. Your source files are never deleted.
                  </p>
                )}
              </div>

              {/* Videos */}
              <div style={{ marginBottom: 16 }}>
                <span style={{ ...sectionLabel, marginBottom: 4 }}>Videos</span>
                <p style={{ margin: "0 0 12px", fontSize: 12, color: "#9ca3af", lineHeight: 1.5 }}>
                  Each video below becomes its own output file. Add files within a video to join them in order; add more videos to process several in one run.
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {localGroups.map((g, i) => (
                    <LocalVideo
                      key={g.id}
                      group={g}
                      index={i}
                      canRemove={localGroups.length > 1}
                      onName={name => setLocalName(g.id, name)}
                      onFile={(j, v) => setLocalFile(g.id, j, v)}
                      onAddFile={() => addLocalFile(g.id)}
                      onRemoveFile={j => removeLocalFile(g.id, j)}
                      onRemove={() => removeLocalGroup(g.id)}
                    />
                  ))}
                </div>
                <button
                  onClick={addLocalGroup}
                  style={{ marginTop: 12, padding: "9px 14px", fontSize: 13, border: "1.5px solid #c4b5fd", borderRadius: 8, background: "#f5f3ff", color: "#6d28d9", cursor: "pointer", fontWeight: 700, width: "100%" }}
                >+ Add another video</button>
              </div>

              <TransformPanel
                rotation={localRotation} setRotation={setLocalRotation}
                trimStart={localTrimStart} setTrimStart={setLocalTrimStart}
                trimEnd={localTrimEnd} setTrimEnd={setLocalTrimEnd}
                onChange={invalidateLocal} multi={localMulti}
              />

              {pathsAdvanced}

              <button
                onClick={handleGenerateLocal}
                disabled={!localCanGenerate}
                style={{ width: "100%", padding: "11px 0", fontSize: 14, fontWeight: 700, borderRadius: 10, border: "none", cursor: localCanGenerate ? "pointer" : "not-allowed", background: localCanGenerate ? "linear-gradient(135deg, #6366f1, #818cf8)" : "#e5e7eb", color: localCanGenerate ? "#fff" : "#9ca3af", transition: "opacity 0.15s" }}
              >
                {localCanGenerate && localCompleteCount > 1 ? `Generate script (${localCompleteCount} files)` : "Generate script"}
              </button>
              {!localCanGenerate && (
                <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "#9ca3af", textAlign: "center" }}>{localHint}</p>
              )}
            </div>

            {localBat && <OutputPanel filename={localFilename} content={localBat} />}
          </>
        )}

        {/* ─── PLAYLIST MODE ─── */}
        {mode === "playlist" && (
          <>
            <div style={{ background: "#fff", borderRadius: 16, padding: 28, boxShadow: "0 4px 32px rgba(0,0,0,0.25)" }}>

              {/* Step 1 */}
              <div style={{ marginBottom: 22 }}>
                <span style={{ ...sectionLabel, marginBottom: 6 }}>
                  <span style={{ color: "#6366f1" }}>Step 1</span> · List the playlist
                </span>
                <p style={{ margin: "0 0 10px", fontSize: 12, color: "#6b7280", lineHeight: 1.5 }}>
                  Paste a playlist URL. This makes a small <code style={{ fontSize: 11, background: "#f1f5f9", padding: "1px 5px", borderRadius: 4 }}>dump_playlist.bat</code> that
                  writes every video's title + link to <code style={{ fontSize: 11, background: "#f1f5f9", padding: "1px 5px", borderRadius: 4 }}>playlist.txt</code>.
                </p>
                <input
                  type="text"
                  value={playlistUrl}
                  onChange={e => { setPlaylistUrl(e.target.value); setDumpBat(null); }}
                  placeholder="https://www.youtube.com/playlist?list=…"
                  style={{ display: "block", width: "100%", boxSizing: "border-box", padding: "9px 12px", fontSize: 13, fontFamily: "monospace", border: "1.5px solid #d1d5db", borderRadius: 8, outline: "none", background: "#fafafa", color: "#111", marginBottom: 10 }}
                />
                <button
                  onClick={handleGenerateDump}
                  disabled={!playlistUrl.trim()}
                  style={{ width: "100%", padding: "9px 0", fontSize: 13, fontWeight: 700, borderRadius: 8, border: "none", cursor: playlistUrl.trim() ? "pointer" : "not-allowed", background: playlistUrl.trim() ? "#eef2ff" : "#f3f4f6", color: playlistUrl.trim() ? "#4338ca" : "#9ca3af" }}
                >Make dump_playlist.bat</button>
              </div>

              {dumpBat && <OutputPanel filename="dump_playlist.bat" content={dumpBat} />}

              {/* Step 2 */}
              <div style={{ marginTop: dumpBat ? 22 : 0, marginBottom: 22 }}>
                <span style={{ ...sectionLabel, marginBottom: 6 }}>
                  <span style={{ color: "#6366f1" }}>Step 2</span> · Paste playlist.txt back
                </span>
                <p style={{ margin: "0 0 10px", fontSize: 12, color: "#6b7280", lineHeight: 1.5 }}>
                  Run the .bat, open <code style={{ fontSize: 11, background: "#f1f5f9", padding: "1px 5px", borderRadius: 4 }}>playlist.txt</code>, copy everything, and paste it here.
                </p>
                <textarea
                  value={pasted}
                  onChange={e => setPasted(e.target.value)}
                  placeholder={"1 ||| https://youtu.be/… ||| Match A part 1\n2 ||| https://youtu.be/… ||| Match A part 2\n3 ||| https://youtu.be/… ||| Match B p1"}
                  rows={6}
                  style={{ display: "block", width: "100%", boxSizing: "border-box", padding: "10px 12px", fontSize: 11.5, fontFamily: "monospace", lineHeight: 1.5, border: "1.5px solid #d1d5db", borderRadius: 8, outline: "none", background: "#fafafa", color: "#111", resize: "vertical", marginBottom: 10 }}
                />
                <button
                  onClick={handleParse}
                  disabled={!pasted.trim()}
                  style={{ width: "100%", padding: "9px 0", fontSize: 13, fontWeight: 700, borderRadius: 8, border: "none", cursor: pasted.trim() ? "pointer" : "not-allowed", background: pasted.trim() ? "#eef2ff" : "#f3f4f6", color: pasted.trim() ? "#4338ca" : "#9ca3af" }}
                >Detect matches</button>
              </div>

              {/* Step 3 */}
              {parsed && (
                <div>
                  <span style={{ ...sectionLabel, marginBottom: 6 }}>
                    <span style={{ color: "#6366f1" }}>Step 3</span> · Review the groups
                  </span>
                  {items.length === 0 ? (
                    <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "#dc2626" }}>
                      Couldn't find any links in that text. Make sure you pasted the contents of playlist.txt.
                    </p>
                  ) : (
                    <>
                      <p style={{ margin: "0 0 12px", fontSize: 12, color: "#6b7280", lineHeight: 1.5 }}>
                        Grouped by detected part markers (p1/p2, part 1, (1)…). Rename outputs, reorder parts, move a
                        video between matches, or untick a match to skip it.
                      </p>
                      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
                        {jobs.map(job => (
                          <JobCard
                            key={job.id}
                            job={job}
                            jobs={jobs}
                            items={items}
                            onRename={name => renameJob(job.id, name)}
                            onToggle={() => toggleJob(job.id)}
                            onMoveItem={moveItem}
                            onReassign={reassignItem}
                            onRemoveItem={removeItem}
                          />
                        ))}
                      </div>
                      <button
                        onClick={addJob}
                        style={{ width: "100%", padding: "7px 14px", fontSize: 12.5, border: "1.5px dashed #c4b5fd", borderRadius: 8, background: "#faf5ff", color: "#7c3aed", cursor: "pointer", fontWeight: 600, marginBottom: 18 }}
                      >+ Add empty group</button>

                      {pathsAdvanced}

                      <button
                        onClick={handleGenerateJoin}
                        disabled={activeJobs.length === 0}
                        style={{ width: "100%", padding: "11px 0", fontSize: 14, fontWeight: 700, borderRadius: 10, border: "none", cursor: activeJobs.length ? "pointer" : "not-allowed", background: activeJobs.length ? "linear-gradient(135deg, #6366f1, #818cf8)" : "#e5e7eb", color: activeJobs.length ? "#fff" : "#9ca3af" }}
                      >Generate script ({activeJobs.length} file{activeJobs.length === 1 ? "" : "s"})</button>
                      {activeJobs.length > 0 && (
                        <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "#9ca3af", textAlign: "center" }}>
                          {totalParts} video{totalParts === 1 ? "" : "s"} → {activeJobs.length} output file{activeJobs.length === 1 ? "" : "s"}
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            {joinBat && <OutputPanel filename="playlist_download_join.bat" content={joinBat} />}
          </>
        )}

        <p style={{ marginTop: 16, fontSize: 11, color: "#475569", textAlign: "center" }}>
          {mode === "local"
            ? "Requires ffmpeg · Works on files already on your machine · Originals never deleted · Joins use stream copy unless rotating"
            : "Requires yt-dlp + ffmpeg · One file per video · Joins use stream copy unless rotating"}
        </p>

      </div>
    </div>
  );
}
