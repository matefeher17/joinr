import { useState, useCallback } from "react";

const DEFAULT_YTDLP = "C:\\ytdlp\\yt-dlp.exe";
const DEFAULT_FFMPEG = "C:\\ytdlp\\ffmpeg.exe";
const DEFAULT_OUTDIR = "C:\\ytdlp\\Output";

function isYouTubeUrl(url) {
  return /youtu(be\.com|\.be)\//i.test(url);
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim();
}

function generateBat({ outputName, urls, ytdlp, ffmpeg, outdir }) {
  const safe = sanitizeFilename(outputName) || "output";
  const parts = urls.map((url, i) => {
    const n = i + 1;
    return `echo === Downloading part ${n} ===\n%YTDLP% -f "%FMT%" --merge-output-format mp4 -o "${safe} p${n}.mp4" ${url}`;
  });

  const filelistLines = urls.map((_, i) => {
    const n = i + 1;
    return `echo file '${safe} p${n}.mp4'`;
  });

  return `@echo off
setlocal enabledelayedexpansion

set YTDLP=${ytdlp}
set FFMPEG=${ffmpeg}
set OUTDIR=${outdir}

if not exist "%OUTDIR%" mkdir "%OUTDIR%"
cd /d "%OUTDIR%"

set FMT=bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b

${parts.join("\n\n")}

echo === Joining parts ===
(
${filelistLines.join("\n")}
) > filelist.txt

%FFMPEG% -f concat -safe 0 -i filelist.txt -c copy "${safe}.mp4"

del filelist.txt
${urls.length > 1 ? `\ndel ${urls.map((_, i) => `"${safe} p${i + 1}.mp4"`).join(" ")}` : ""}

echo.
echo Done! Output: ${safe}.mp4
pause
`;
}

function UrlRow({ index, value, onChange, onRemove, canRemove }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <span style={{
        fontSize: 11, fontWeight: 700, color: "#6b7280",
        minWidth: 24, textAlign: "right", fontFamily: "monospace"
      }}>
        {index + 1}
      </span>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="https://youtu.be/…"
        style={{
          flex: 1, padding: "9px 12px", fontSize: 13,
          fontFamily: "monospace",
          border: "1.5px solid",
          borderColor: value && !isYouTubeUrl(value) ? "#f87171" : "#d1d5db",
          borderRadius: 8, outline: "none", background: "#fafafa",
          transition: "border-color 0.15s",
          color: "#111",
        }}
      />
      {canRemove && (
        <button
          onClick={onRemove}
          title="Remove"
          style={{
            width: 30, height: 30, borderRadius: 6, border: "none",
            background: "#fee2e2", color: "#dc2626", cursor: "pointer",
            fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}
        >×</button>
      )}
    </div>
  );
}

export default function App() {
  const [outputName, setOutputName] = useState("");
  const [urls, setUrls] = useState(["", ""]);
  const [ytdlp, setYtdlp] = useState(DEFAULT_YTDLP);
  const [ffmpeg, setFfmpeg] = useState(DEFAULT_FFMPEG);
  const [outdir, setOutdir] = useState(DEFAULT_OUTDIR);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [copied, setCopied] = useState(false);
  const [generated, setGenerated] = useState(null);

  const updateUrl = (i, val) => setUrls(u => u.map((v, j) => j === i ? val : v));
  const addUrl = () => setUrls(u => [...u, ""]);
  const removeUrl = (i) => setUrls(u => u.filter((_, j) => j !== i));

  const filledUrls = urls.filter(u => u.trim());
  const allValid = filledUrls.length > 0 && filledUrls.every(isYouTubeUrl);
  const canGenerate = allValid && outputName.trim();

  const handleGenerate = useCallback(() => {
    const bat = generateBat({
      outputName: outputName.trim(),
      urls: filledUrls,
      ytdlp, ffmpeg, outdir
    });
    setGenerated(bat);
  }, [outputName, filledUrls, ytdlp, ffmpeg, outdir]);

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

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      padding: "40px 16px", fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      <div style={{ width: "100%", maxWidth: 560 }}>

        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: "linear-gradient(135deg, #6366f1, #818cf8)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 18,
            }}>▶</div>
            <h1 style={{
              margin: 0, fontSize: 22, fontWeight: 700, color: "#f1f5f9",
              letterSpacing: "-0.3px",
            }}>Joinr</h1>
          </div>
          <p style={{ margin: 0, color: "#94a3b8", fontSize: 13.5 }}>
            Paste YouTube links → download a .bat that fetches and joins them into one file.
          </p>
        </div>

        {/* Card */}
        <div style={{
          background: "#fff", borderRadius: 16, padding: 28,
          boxShadow: "0 4px 32px rgba(0,0,0,0.25)",
        }}>

          {/* Output name */}
          <label style={{ display: "block", marginBottom: 16 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#374151", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Output filename
            </span>
            <input
              type="text"
              value={outputName}
              onChange={e => { setOutputName(e.target.value); setGenerated(null); }}
              placeholder="e.g. Enis Yuda top v Dorel Leon hr1 15pt"
              style={{
                display: "block", width: "100%", marginTop: 6,
                padding: "9px 12px", fontSize: 13.5, boxSizing: "border-box",
                border: "1.5px solid #d1d5db", borderRadius: 8,
                outline: "none", background: "#fafafa", color: "#111",
              }}
            />
            {outputName && <span style={{ fontSize: 11, color: "#6b7280", marginTop: 4, display: "block" }}>
              → {sanitizeFilename(outputName) || "output"}.mp4
            </span>}
          </label>

          {/* URLs */}
          <div style={{ marginBottom: 12 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#374151", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 8 }}>
              YouTube links <span style={{ color: "#9ca3af", fontWeight: 400, textTransform: "none" }}>(in order)</span>
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {urls.map((url, i) => (
                <UrlRow
                  key={i} index={i} value={url}
                  onChange={v => { updateUrl(i, v); setGenerated(null); }}
                  onRemove={() => { removeUrl(i); setGenerated(null); }}
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
            >
              + Add another part
            </button>
          </div>

          {/* Advanced */}
          <div style={{ marginBottom: 20 }}>
            <button
              onClick={() => setShowAdvanced(a => !a)}
              style={{
                background: "none", border: "none", padding: 0,
                fontSize: 12, color: "#6b7280", cursor: "pointer",
                display: "flex", alignItems: "center", gap: 4,
              }}
            >
              <span style={{ transform: showAdvanced ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform 0.15s" }}>▶</span>
              Paths (yt-dlp, ffmpeg, output folder)
            </button>
            {showAdvanced && (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                {[
                  ["yt-dlp path", ytdlp, setYtdlp],
                  ["ffmpeg path", ffmpeg, setFfmpeg],
                  ["Output folder", outdir, setOutdir],
                ].map(([label, val, setter]) => (
                  <label key={label} style={{ display: "block" }}>
                    <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 600 }}>{label}</span>
                    <input
                      type="text"
                      value={val}
                      onChange={e => { setter(e.target.value); setGenerated(null); }}
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

          {/* Generate button */}
          <button
            onClick={handleGenerate}
            disabled={!canGenerate}
            style={{
              width: "100%", padding: "11px 0", fontSize: 14, fontWeight: 700,
              borderRadius: 10, border: "none", cursor: canGenerate ? "pointer" : "not-allowed",
              background: canGenerate
                ? "linear-gradient(135deg, #6366f1, #818cf8)"
                : "#e5e7eb",
              color: canGenerate ? "#fff" : "#9ca3af",
              transition: "opacity 0.15s",
            }}
          >
            Generate script
          </button>

          {!canGenerate && (
            <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "#9ca3af", textAlign: "center" }}>
              {!outputName.trim() ? "Enter an output filename" : !allValid ? "Add at least one valid YouTube URL" : ""}
            </p>
          )}
        </div>

        {/* Output section */}
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
              maxHeight: 320, overflowY: "auto",
              whiteSpace: "pre",
            }}>{generated}</pre>
          </div>
        )}

        <p style={{ marginTop: 16, fontSize: 11, color: "#475569", textAlign: "center" }}>
          Requires yt-dlp + ffmpeg on your machine · Stream-copied, no re-encoding
        </p>
      </div>
    </div>
  );
}
