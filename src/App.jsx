import { useState, useCallback } from "react";

const DEFAULT_YTDLP = "C:\\ytdlp\\yt-dlp.exe";
const DEFAULT_FFMPEG = "C:\\ytdlp\\ffmpeg.exe";
const DEFAULT_OUTDIR = "C:\\ytdlp\\Output";

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

function isYouTubeUrl(url) {
  return /youtu(be\.com|\.be)\//i.test(url);
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim();
}

function isValidTime(t) {
  return !t.trim() || /^\d{1,2}:\d{2}(:\d{2})?$/.test(t.trim());
}

// ─── Batch generator ────────────────────────────────────────────────────────

function generateBat({ outputName, urls, ytdlp, ffmpeg, outdir, rotation, trimStart, trimEnd }) {
  const safe = sanitizeFilename(outputName) || "output";
  const single = urls.length === 1;

  const downloadParts = urls
    .map((url, i) =>
      `echo === Downloading part ${i + 1} ===\n%YTDLP% -f "%FMT%" --merge-output-format mp4 -o "${safe} p${i + 1}.mp4" ${url}`
    )
    .join("\n\n");

  const needsReencode = rotation !== "none";
  const hasTrim      = !!(trimStart?.trim() || trimEnd?.trim());
  const hasProcessing = needsReencode || hasTrim;

  const vfMap = { cw90: "transpose=1", ccw90: "transpose=2", "180": "vflip,hflip" };
  const vfArg    = needsReencode ? `-vf "${vfMap[rotation]}" ` : "";
  const codecArgs = needsReencode ? "-c:v libx264 -c:a aac" : "-c copy";

  let trimArgs = "";
  if (trimStart?.trim()) trimArgs += `-ss ${trimStart.trim()} `;
  if (trimEnd?.trim())   trimArgs += `-to ${trimEnd.trim()} `;

  let ffmpegSection;

  if (single && !hasProcessing) {
    // Download only — just rename the file
    ffmpegSection =
`echo === Renaming output ===
ren "${safe} p1.mp4" "${safe}.mp4"`;

  } else if (single) {
    // Download + process (trim / rotate / both)
    ffmpegSection =
`echo === Processing video ===
%FFMPEG% -i "${safe} p1.mp4" ${trimArgs}${vfArg}${codecArgs} "${safe}.mp4"

del "${safe} p1.mp4"`;

  } else {
    // Multiple parts — join, then optionally process
    const filelistLines = urls.map((_, i) => `echo file '${safe} p${i + 1}.mp4'`).join("\n");
    const deleteParts   = urls.map((_, i) => `"${safe} p${i + 1}.mp4"`).join(" ");

    ffmpegSection =
`echo === Joining${hasProcessing ? " and processing" : ""} parts ===
(
${filelistLines}
) > filelist.txt

%FFMPEG% -f concat -safe 0 -i filelist.txt ${trimArgs}${vfArg}${codecArgs} "${safe}.mp4"

del filelist.txt
del ${deleteParts}`;
  }

  return `@echo off
setlocal enabledelayedexpansion

set YTDLP=${ytdlp}
set FFMPEG=${ffmpeg}
set OUTDIR=${outdir}

if not exist "%OUTDIR%" mkdir "%OUTDIR%"
cd /d "%OUTDIR%"

set FMT=bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b

${downloadParts}

${ffmpegSection}

echo.
echo Done! Output: ${safe}.mp4
pause
`;
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function UrlRow({ index, value, onChange, onRemove, canRemove }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", minWidth: 24, textAlign: "right", fontFamily: "monospace" }}>
        {index + 1}
      </span>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="https://youtu.be/…"
        style={{
          flex: 1, padding: "9px 12px", fontSize: 13, fontFamily: "monospace",
          border: "1.5px solid",
          borderColor: value && !isYouTubeUrl(value) ? "#f87171" : "#d1d5db",
          borderRadius: 8, outline: "none", background: "#fafafa",
          transition: "border-color 0.15s", color: "#111",
        }}
      />
      {canRemove && (
        <button
          onClick={onRemove}
          title="Remove"
          style={{
            width: 30, height: 30, borderRadius: 6, border: "none",
            background: "#fee2e2", color: "#dc2626", cursor: "pointer",
            fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          }}
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
          width: "100%", boxSizing: "border-box",
          padding: "9px 12px", fontSize: 13, fontFamily: "monospace",
          border: "1.5px solid", borderColor: invalid ? "#f87171" : "#d1d5db",
          borderRadius: 8, outline: "none", background: "#fff", color: "#111",
          transition: "border-color 0.15s",
        }}
      />
    </div>
  );
}

// ─── App ────────────────────────────────────────────────────────────────────

export default function App() {
  const [outputName, setOutputName] = useState("");
  const [urls, setUrls]             = useState(["", ""]);
  const [ytdlp, setYtdlp]           = useState(DEFAULT_YTDLP);
  const [ffmpeg, setFfmpeg]         = useState(DEFAULT_FFMPEG);
  const [outdir, setOutdir]         = useState(DEFAULT_OUTDIR);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [rotation, setRotation]     = useState("none");
  const [trimStart, setTrimStart]   = useState("");
  const [trimEnd, setTrimEnd]       = useState("");
  const [copied, setCopied]         = useState(false);
  const [generated, setGenerated]   = useState(null);

  const invalidate = () => setGenerated(null);

  const updateUrl = (i, val) => { setUrls(u => u.map((v, j) => j === i ? val : v)); invalidate(); };
  const addUrl    = ()       => { setUrls(u => [...u, ""]); invalidate(); };
  const removeUrl = (i)      => { setUrls(u => u.filter((_, j) => j !== i)); invalidate(); };

  const filledUrls  = urls.filter(u => u.trim());
  const allValid    = filledUrls.length > 0 && filledUrls.every(isYouTubeUrl);
  const timesValid  = isValidTime(trimStart) && isValidTime(trimEnd);
  const canGenerate = !!(outputName.trim() && allValid && timesValid);

  const handleGenerate = useCallback(() => {
    setGenerated(generateBat({
      outputName: outputName.trim(), urls: filledUrls,
      ytdlp, ffmpeg, outdir, rotation, trimStart, trimEnd,
    }));
  }, [outputName, filledUrls, ytdlp, ffmpeg, outdir, rotation, trimStart, trimEnd]);

  const handleDownload = () => {
    if (!generated) return;
    const blob = new Blob([generated], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${sanitizeFilename(outputName) || "output"}_download_join.bat`;
    a.click();
  };

  const handleCopy = () => {
    if (!generated) return;
    navigator.clipboard.writeText(generated).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  const handleDownloadInstaller = () => {
    const blob = new Blob([INSTALL_BAT_CONTENT], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "install_ytdlp.bat";
    a.click();
  };

  const sectionLabel = {
    fontSize: 12, fontWeight: 600, color: "#374151",
    textTransform: "uppercase", letterSpacing: "0.06em",
    display: "block",
  };

  const hintText =
    !outputName.trim()   ? "Enter an output filename"         :
    !allValid            ? "Add at least one valid YouTube URL" :
    !timesValid          ? "Fix time format (M:SS or H:MM:SS)" : "";

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
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: "linear-gradient(135deg, #6366f1, #818cf8)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 18,
            }}>▶</div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.3px" }}>
              Joinr
            </h1>
          </div>
          <p style={{ margin: 0, color: "#94a3b8", fontSize: 13.5 }}>
            Paste YouTube links → generates a .bat that downloads, joins, rotates, or trims them.
          </p>
        </div>

        {/* First-time setup banner */}
        <div style={{
          marginBottom: 16,
          padding: "14px 16px",
          background: "rgba(99, 102, 241, 0.08)",
          border: "1px solid rgba(99, 102, 241, 0.25)",
          borderRadius: 12,
          display: "flex",
          alignItems: "center",
          gap: 14,
        }}>
          <div style={{ fontSize: 22, flexShrink: 0 }}>🔧</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", display: "block", marginBottom: 3 }}>
              First time? Install yt-dlp &amp; ffmpeg first
            </span>
            <span style={{ fontSize: 11.5, color: "#64748b", lineHeight: 1.5 }}>
              Download and run{" "}
              <code style={{
                color: "#a5b4fc", background: "rgba(99,102,241,0.15)",
                padding: "1px 5px", borderRadius: 4, fontSize: 11,
              }}>install_ytdlp.bat</code>
              {" "}once — it auto-downloads both tools and adds them to your PATH.
            </span>
          </div>
          <button
            onClick={handleDownloadInstaller}
            style={{
              padding: "8px 13px", fontSize: 12, fontWeight: 700, flexShrink: 0,
              borderRadius: 8, border: "1px solid rgba(99, 102, 241, 0.4)",
              background: "rgba(99, 102, 241, 0.15)", color: "#a5b4fc",
              cursor: "pointer", whiteSpace: "nowrap",
            }}
          >⬇ install_ytdlp.bat</button>
        </div>

        {/* Card */}
        <div style={{ background: "#fff", borderRadius: 16, padding: 28, boxShadow: "0 4px 32px rgba(0,0,0,0.25)" }}>

          {/* Output filename */}
          <div style={{ marginBottom: 16 }}>
            <span style={{ ...sectionLabel, marginBottom: 6 }}>Output filename</span>
            <input
              type="text"
              value={outputName}
              onChange={e => { setOutputName(e.target.value); invalidate(); }}
              placeholder="e.g. Enis Yuda top v Dorel Leon hr1 15pt"
              style={{
                display: "block", width: "100%", boxSizing: "border-box",
                padding: "9px 12px", fontSize: 13.5,
                border: "1.5px solid #d1d5db", borderRadius: 8,
                outline: "none", background: "#fafafa", color: "#111",
              }}
            />
            {outputName && (
              <span style={{ fontSize: 11, color: "#6b7280", marginTop: 4, display: "block" }}>
                → {sanitizeFilename(outputName) || "output"}.mp4
              </span>
            )}
          </div>

          {/* URLs */}
          <div style={{ marginBottom: 16 }}>
            <span style={{ ...sectionLabel, marginBottom: 8 }}>
              YouTube links{" "}
              <span style={{ color: "#9ca3af", fontWeight: 400, textTransform: "none" }}>
                {filledUrls.length <= 1 ? "(single video works fine)" : "(in order)"}
              </span>
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {urls.map((url, i) => (
                <UrlRow
                  key={i} index={i} value={url}
                  onChange={v => updateUrl(i, v)}
                  onRemove={() => removeUrl(i)}
                  canRemove={urls.length > 1}
                />
              ))}
            </div>
            <button
              onClick={addUrl}
              style={{
                marginTop: 10, padding: "7px 14px", fontSize: 12.5,
                border: "1.5px dashed #c4b5fd", borderRadius: 8,
                background: "#faf5ff", color: "#7c3aed", cursor: "pointer",
                fontWeight: 600, width: "100%",
              }}
            >+ Add another part</button>
          </div>

          {/* ── Transform ─────────────────────────────────────────────────── */}
          <div style={{
            marginBottom: 16, padding: "14px 16px",
            background: "#f8fafc", borderRadius: 10, border: "1px solid #e5e7eb",
          }}>
            <span style={{ ...sectionLabel, marginBottom: 14 }}>Transform</span>

            {/* Rotation */}
            <div style={{ marginBottom: 16 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", display: "block", marginBottom: 8 }}>
                Rotation
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                {ROTATIONS.map(opt => {
                  const active = rotation === opt.value;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => { setRotation(opt.value); invalidate(); }}
                      style={{
                        flex: 1, padding: "7px 0", fontSize: 12.5, fontWeight: 600,
                        borderRadius: 7, border: "1.5px solid",
                        borderColor: active ? "#6366f1" : "#d1d5db",
                        background: active ? "#eef2ff" : "#fff",
                        color: active ? "#4338ca" : "#6b7280",
                        cursor: "pointer", transition: "all 0.12s",
                      }}
                    >{opt.label}</button>
                  );
                })}
              </div>
              {rotation !== "none" && (
                <p style={{ margin: "7px 0 0", fontSize: 11, color: "#7c3aed" }}>
                  ⚠ Re-encodes with libx264 — slower than stream copy
                </p>
              )}
            </div>

            {/* Trim */}
            <div>
              <span style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", display: "block", marginBottom: 8 }}>
                Trim{" "}
                <span style={{ fontWeight: 400 }}>— leave blank to keep full length</span>
              </span>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                <TimeInput
                  label="Start time"
                  value={trimStart}
                  onChange={v => { setTrimStart(v); invalidate(); }}
                  placeholder="0:30"
                />
                <span style={{ color: "#d1d5db", paddingBottom: 11, fontSize: 18 }}>→</span>
                <TimeInput
                  label="End time"
                  value={trimEnd}
                  onChange={v => { setTrimEnd(v); invalidate(); }}
                  placeholder="1:45:00"
                />
              </div>
              {(trimStart || trimEnd) && !timesValid && (
                <p style={{ margin: "7px 0 0", fontSize: 11, color: "#f87171" }}>
                  Use M:SS or H:MM:SS (e.g. 1:30 or 0:01:30)
                </p>
              )}
              {(trimStart || trimEnd) && timesValid && rotation === "none" && (
                <p style={{ margin: "7px 0 0", fontSize: 11, color: "#6b7280" }}>
                  Trim without rotation uses stream copy — cuts at nearest keyframe
                </p>
              )}
            </div>
          </div>

          {/* Advanced (paths) */}
          <div style={{ marginBottom: 20 }}>
            <button
              onClick={() => setShowAdvanced(a => !a)}
              style={{
                background: "none", border: "none", padding: 0,
                fontSize: 12, color: "#6b7280", cursor: "pointer",
                display: "flex", alignItems: "center", gap: 4,
              }}
            >
              <span style={{
                transform: showAdvanced ? "rotate(90deg)" : "none",
                display: "inline-block", transition: "transform 0.15s",
              }}>▶</span>
              Paths (yt-dlp, ffmpeg, output folder)
            </button>
            {showAdvanced && (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                {[
                  ["yt-dlp path",    ytdlp,  setYtdlp],
                  ["ffmpeg path",    ffmpeg, setFfmpeg],
                  ["Output folder",  outdir, setOutdir],
                ].map(([label, val, setter]) => (
                  <label key={label} style={{ display: "block" }}>
                    <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 600 }}>{label}</span>
                    <input
                      type="text"
                      value={val}
                      onChange={e => { setter(e.target.value); invalidate(); }}
                      style={{
                        display: "block", width: "100%", marginTop: 4,
                        padding: "7px 10px", fontSize: 12, boxSizing: "border-box",
                        fontFamily: "monospace",
                        border: "1.5px solid #e5e7eb", borderRadius: 6,
                        background: "#f9fafb", color: "#374151", outline: "none",
                      }}
                    />
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Generate */}
          <button
            onClick={handleGenerate}
            disabled={!canGenerate}
            style={{
              width: "100%", padding: "11px 0", fontSize: 14, fontWeight: 700,
              borderRadius: 10, border: "none",
              cursor: canGenerate ? "pointer" : "not-allowed",
              background: canGenerate ? "linear-gradient(135deg, #6366f1, #818cf8)" : "#e5e7eb",
              color: canGenerate ? "#fff" : "#9ca3af",
              transition: "opacity 0.15s",
            }}
          >
            Generate script
          </button>

          {!canGenerate && (
            <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "#9ca3af", textAlign: "center" }}>
              {hintText}
            </p>
          )}
        </div>

        {/* Generated output */}
        {generated && (
          <div style={{
            marginTop: 20, background: "#0f172a", borderRadius: 16,
            border: "1px solid #1e293b", overflow: "hidden",
          }}>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "12px 16px", borderBottom: "1px solid #1e293b",
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#64748b" }}>
                {sanitizeFilename(outputName)}_download_join.bat
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={handleCopy}
                  style={{
                    padding: "5px 12px", fontSize: 12, borderRadius: 6,
                    border: "1px solid #334155", background: "#1e293b",
                    color: copied ? "#4ade80" : "#94a3b8", cursor: "pointer", fontWeight: 600,
                  }}
                >{copied ? "✓ Copied" : "Copy"}</button>
                <button
                  onClick={handleDownload}
                  style={{
                    padding: "5px 12px", fontSize: 12, borderRadius: 6,
                    border: "none", background: "linear-gradient(135deg, #6366f1, #818cf8)",
                    color: "#fff", cursor: "pointer", fontWeight: 700,
                  }}
                >⬇ Download .bat</button>
              </div>
            </div>
            <pre style={{
              margin: 0, padding: "16px", fontSize: 11,
              fontFamily: "monospace", color: "#94a3b8",
              overflowX: "auto", lineHeight: 1.6,
              maxHeight: 320, overflowY: "auto", whiteSpace: "pre",
            }}>{generated}</pre>
          </div>
        )}

        <p style={{ marginTop: 16, fontSize: 11, color: "#475569", textAlign: "center" }}>
          Requires yt-dlp + ffmpeg · Rotation forces re-encode · Trim uses stream copy unless rotating
        </p>

      </div>
    </div>
  );
}
