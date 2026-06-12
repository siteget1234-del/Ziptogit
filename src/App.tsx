import { useState, useEffect, useRef, useCallback } from "react";
import { BrowserRouter, Routes, Route, Link, useLocation } from "react-router-dom";
import { fetchRepositories, fetchUser, extractZip, uploadToGitHub, ExtractedFile } from "./lib/github";
import { Github, LogOut, Upload, Loader2, CheckCircle, BookOpen, Archive, AlertCircle, FileArchive, X, ChevronDown, ChevronUp } from "lucide-react";

// --- Custom Event Tracking Wrapper --- //
function trackEvent(eventName: string, params?: Record<string, any>) {
  if (typeof window !== "undefined" && (window as any).gtag) {
    (window as any).gtag("event", eventName, params);
  }
}

// --- Layout & Presentational Components --- //
function Footer() {
  return (
    <footer className="mt-16 py-8 border-t border-slate-200 bg-white text-center flex flex-col items-center">
      <div className="flex gap-4 mb-3 text-xs text-slate-400">
        <Link to="/how-it-works" className="hover:text-slate-600 transition-colors">How It Works</Link>
        <span>&middot;</span>
        <Link to="/privacy" className="hover:text-slate-600 transition-colors">Privacy Policy</Link>
        <span>&middot;</span>
        <Link to="/contact" className="hover:text-slate-600 transition-colors">Contact</Link>
      </div>
      <p className="text-[11px] text-slate-400/80">© {new Date().getFullYear()} ZiptoGit. Created by Dipesh Nalawade.</p>
    </footer>
  );
}

function PageLayout({ children, title }: { children: React.ReactNode, title?: string }) {
  // Setup page view tracking on mount/title change
  useEffect(() => {
    if (typeof window !== "undefined" && (window as any).gtag) {
      const configObj: any = { page_path: window.location.pathname };
      if (title) configObj.page_title = title;
      (window as any).gtag("config", (window as any).VITE_GA_MEASUREMENT_ID || 'G-TRACKING_ID', configObj);
    }
    if (title) document.title = `${title} | ZiptoGit`;
  }, [title]);

  return (
    <div className="min-h-screen bg-[#f8f9fa] flex flex-col font-sans text-slate-900">
      <div className="flex-1 flex flex-col items-center justify-center p-4">
        {children}
      </div>
      <Footer />
    </div>
  );
}

export function ZipUploader() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [repos, setRepos] = useState<any[]>([]);
  const [selectedRepoFullId, setSelectedRepoFullId] = useState<string>("");
  
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [extractedFiles, setExtractedFiles] = useState<ExtractedFile[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractingName, setExtractingName] = useState("");
  
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatusMsg, setUploadStatusMsg] = useState("");
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });
  const [uploadSuccessUrl, setUploadSuccessUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const savedToken = localStorage.getItem("github_token");
    if (savedToken) {
      setToken(savedToken);
      loadUserData(savedToken);
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "OAUTH_AUTH_SUCCESS") {
        const savedState = sessionStorage.getItem("oauth_state");
        if (savedState && event.data.state && savedState !== event.data.state) {
          console.error("OAuth state mismatch! Possible CSRF attack.");
          setErrorMsg("Security validation failed during authentication.");
          return;
        }
        sessionStorage.removeItem("oauth_state");
        const newToken = event.data.token;
        localStorage.setItem("github_token", newToken);
        setToken(newToken);
        loadUserData(newToken);
      }
    };
    
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const loadUserData = async (activeToken: string) => {
    try {
      const pUser = await fetchUser(activeToken);
      setUser(pUser);
      const pRepos = await fetchRepositories(activeToken);
      setRepos(pRepos);
      if (pRepos.length > 0 && !selectedRepoFullId) {
        setSelectedRepoFullId(pRepos[0].full_name);
      }
    } catch (err: any) {
      console.error(err);
      if (err.status === 401) {
        localStorage.removeItem("github_token");
        setToken(null);
      } else {
        setErrorMsg("Failed to load GitHub user data.");
      }
    }
  };

  const handleConnect = useCallback(async () => {
    try {
      trackEvent("connect_github_initiated");
      setErrorMsg(null);
      const state = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
      sessionStorage.setItem("oauth_state", state);

      const response = await fetch(`/api/auth/url?state=${encodeURIComponent(state)}`);
      if (!response.ok) throw new Error("Failed to get auth URL");
      
      const { url } = await response.json();
      const authWindow = window.open(url, "oauth_popup", "width=600,height=700");
      if (!authWindow) {
        setErrorMsg("Please allow popups to connect your GitHub account.");
      }
    } catch (err) {
      console.error(err);
      setErrorMsg("Failed to start OAuth flow.");
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("github_token");
    setToken(null);
    setUser(null);
    setRepos([]);
    setSelectedFile(null);
    setExtractedFiles([]);
    setUploadSuccessUrl(null);
  }, []);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      e.target.value = ''; // Reset input to allow selecting the same file again
      if (file.type !== "application/zip" && !file.name.endsWith(".zip")) {
        setErrorMsg("Please select a valid ZIP file.");
        return;
      }
      setErrorMsg(null);
      setSelectedFile(file);
      setUploadSuccessUrl(null);
      trackEvent("zip_uploaded", { size_bytes: file.size, file_name: file.name });
      
      setIsExtracting(true);
      try {
        const files = await extractZip(file, (fname) => setExtractingName(fname));
        setExtractedFiles(files);
      } catch (err) {
        console.error(err);
        setErrorMsg("Failed to extract ZIP.");
        setExtractedFiles([]);
      } finally {
        setIsExtracting(false);
      }
    }
  };

  const handleUpload = async () => {
    if (!token || !selectedRepoFullId || extractedFiles.length === 0) return;
    
    // If it was already successful, open the link instead
    if (uploadSuccessUrl) {
      window.open(uploadSuccessUrl, "_blank");
      return;
    }

    setIsUploading(true);
    setErrorMsg(null);
    const [owner, repo] = selectedRepoFullId.split("/");
    
    try {
      await uploadToGitHub(
        token,
        owner,
        repo,
        extractedFiles,
        "Upload files via GitHub ZIP Sync",
        (status, current, total) => {
          setUploadStatusMsg(status);
          setUploadProgress({ current, total });
        }
      );
      setUploadSuccessUrl(`https://github.com/${selectedRepoFullId}`);
      trackEvent("push_successful", { files_count: extractedFiles.length });
    } catch (err: any) {
      console.error("Upload error details:", err);
      const apiErrorMsg = err.response?.data?.message;
      setErrorMsg(apiErrorMsg ? `GitHub API Error: ${apiErrorMsg}` : (err.message || "An error occurred during upload."));
      trackEvent("push_failed", { error: apiErrorMsg || err.message });
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="w-full max-w-[420px] bg-white rounded-2xl shadow-xl shadow-slate-200/50 overflow-hidden">
        
        {/* Header Section */}
        <div className="bg-[#111827] px-8 py-10 flex flex-col items-center text-center">
          <div className="w-14 h-14 bg-white/5 rounded-full flex items-center justify-center mb-5">
            <Github className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-[22px] font-semibold tracking-tight text-white mb-2">GitHub Zip Sync</h1>
          <p className="text-slate-400 text-[13.5px] leading-relaxed max-w-[280px]">
            Upload your AI Studio ZIP exports and push them directly to your repositories.
          </p>
        </div>

        {/* Content Section */}
        <div className="p-8 bg-white">
          {!token ? (
            <div className="flex flex-col items-center">
              <p className="text-slate-500 text-[13.5px] leading-relaxed text-center mb-8 px-2">
                Connect your GitHub account to securely push zip contents directly to your repositories without needing a local Git environment.
              </p>
              <button 
                onClick={handleConnect} 
                className="w-full bg-[#111827] text-white py-3.5 rounded-xl font-medium focus:ring-4 focus:ring-slate-100 transition-all flex justify-center items-center gap-2 hover:bg-[#1a2333]"
              >
                <Github className="w-5 h-5" />
                Connect GitHub
              </button>
              {errorMsg && (
                <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-100 text-red-600 text-sm w-full flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{errorMsg}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col flex-1 animate-in fade-in duration-300">
              
              {/* Repository Select */}
              <div className="mb-7">
                <div className="flex justify-between items-center mb-2.5">
                  <label className="text-[13px] font-semibold text-slate-700 flex items-center gap-2">
                    <BookOpen className="w-4 h-4 text-slate-400" />
                    Select Repository
                  </label>
                  <button 
                    onClick={logout} 
                    className="text-[12px] text-slate-400 hover:text-slate-600 flex items-center gap-1.5 transition-colors"
                  >
                    <LogOut className="w-3 h-3" />
                    Disconnect
                  </button>
                </div>
                <div className="relative">
                  <select 
                    value={selectedRepoFullId || ""}
                    onChange={(e) => {
                      setSelectedRepoFullId(e.target.value);
                      setUploadSuccessUrl(null); // Reset success state on repo change
                    }}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm focus:border-slate-400 focus:ring-0 outline-none appearance-none cursor-pointer"
                    disabled={isUploading}
                  >
                    <option value="" disabled>Choose a repository...</option>
                    {repos.map(r => <option key={r.id} value={r.full_name}>{r.name}</option>)}
                  </select>
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                  </div>
                </div>
              </div>

              {/* ZIP Archive Area */}
              <div className="mb-8">
                <label className="text-[13px] font-semibold text-slate-700 flex items-center gap-2 mb-2.5">
                  <Archive className="w-4 h-4 text-slate-400" />
                  ZIP Archive
                </label>
                
                {!selectedFile ? (
                  <div 
                    onClick={() => fileInputRef.current?.click()} 
                    className="border-2 border-dashed border-slate-200 rounded-xl p-8 flex flex-col items-center justify-center text-center cursor-pointer hover:border-slate-300 hover:bg-slate-50 transition-colors"
                  >
                    <input 
                      type="file" 
                      accept=".zip,application/zip" 
                      className="hidden" 
                      ref={fileInputRef} 
                      onChange={handleFileChange} 
                    />
                    <div className="w-12 h-12 bg-slate-50 rounded-full flex items-center justify-center mb-3 text-slate-400">
                      <Upload className="w-5 h-5" />
                    </div>
                    <p className="text-slate-900 text-[14.5px] font-semibold mb-1">Click to upload or drag and drop</p>
                    <p className="text-slate-400 text-[13px]">Valid .zip archive</p>
                  </div>
                ) : (
                  <div className="border border-slate-200 rounded-xl p-4 bg-white flex items-center justify-between">
                    <div className="flex items-center gap-3 overflow-hidden">
                      <div className="w-10 h-10 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
                        {isExtracting ? <Loader2 className="w-5 h-5 animate-spin" /> : <FileArchive className="w-5 h-5" />}
                      </div>
                      <div className="overflow-hidden">
                        <p className="text-sm font-medium text-slate-900 truncate">{selectedFile.name}</p>
                        <p className="text-xs text-slate-500 truncate">
                          {isExtracting ? "Extracting..." : `${extractedFiles.length} files parsed`}
                        </p>
                      </div>
                    </div>
                    {!isUploading && !isExtracting && (
                      <button 
                        onClick={() => {
                          setSelectedFile(null);
                          setUploadSuccessUrl(null);
                        }}
                        className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-full transition-colors shrink-0"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                )}
                
                {errorMsg && (
                  <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-100 text-red-600 text-sm w-full flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{errorMsg}</span>
                  </div>
                )}
              </div>

              {/* Action Button */}
              {uploadSuccessUrl ? (
                <button 
                  onClick={handleUpload}
                  className="w-full py-3.5 bg-[#111827] text-white rounded-xl font-medium text-[15px] transition-colors hover:bg-[#1a2333] flex items-center justify-center gap-2"
                >
                  <CheckCircle className="w-5 h-5 text-emerald-400" />
                  View on GitHub
                </button>
              ) : (
                <button 
                  onClick={handleUpload}
                  disabled={isUploading || isExtracting || !selectedFile || !selectedRepoFullId}
                  className="w-full py-3.5 bg-[#838a94] text-white rounded-xl font-medium text-[15px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[#6c737d] flex items-center justify-center gap-2"
                >
                  {isUploading ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" /> 
                      {uploadStatusMsg || "Uploading..."}
                    </>
                  ) : (
                    "Push to GitHub"
                  )}
                </button>
              )}
              
            </div>
          )}
        </div>
      </div>
  );
}

// --- Content Pages --- //
function PrivacyPage() {
  return (
    <PageLayout title="Privacy Policy">
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-md p-8 sm:p-12 text-slate-700">
        <h1 className="text-3xl font-bold text-slate-900 mb-6">Privacy Policy</h1>
        <p className="mb-4">Last Updated: {new Date().toLocaleDateString()}</p>
        <h2 className="text-xl font-semibold text-slate-900 mt-6 mb-3">1. Information We Collect</h2>
        <p className="mb-4">ZiptoGit requests OAuth access to your GitHub account to push files directly to your repositories. We do not store your repository contents or your source code on our servers.</p>
        <h2 className="text-xl font-semibold text-slate-900 mt-6 mb-3">2. How We Use Information</h2>
        <p className="mb-4">Your GitHub token is stored securely in your browser's local storage and used solely to interface with the GitHub API on your behalf to perform ZIP extraction and commit operations.</p>
        <h2 className="text-xl font-semibold text-slate-900 mt-6 mb-3">3. Third-Party Services</h2>
        <p className="mb-4">We use Google Analytics to monitor usage and improve the tool. We do not sell your data.</p>
      </div>
    </PageLayout>
  );
}

function TermsPage() {
  return (
    <PageLayout title="Terms of Service">
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-md p-8 sm:p-12 text-slate-700">
        <h1 className="text-3xl font-bold text-slate-900 mb-6">Terms of Service</h1>
        <p className="mb-4">Welcome to ZiptoGit by Dipesh Nalawade!</p>
        <h2 className="text-xl font-semibold text-slate-900 mt-6 mb-3">1. Acceptance of Terms</h2>
        <p className="mb-4">By accessing or using our service, you agree to these Terms. If you do not agree, do not use the service.</p>
        <h2 className="text-xl font-semibold text-slate-900 mt-6 mb-3">2. Responsible Use</h2>
        <p className="mb-4">You are responsible for what you upload to your connected GitHub repositories. We are not liable for any code overrides, data loss, or unintended repository modifications.</p>
        <h2 className="text-xl font-semibold text-slate-900 mt-6 mb-3">3. Disclaimer of Warranties</h2>
        <p className="mb-4">ZiptoGit is provided "as is" without warranty of any kind. Use at your own risk.</p>
      </div>
    </PageLayout>
  );
}

function ContactPage() {
  return (
    <PageLayout title="Contact Us">
      <div className="w-full max-w-xl bg-white rounded-2xl shadow-md p-8 sm:p-12 text-center text-slate-700">
        <h1 className="text-3xl font-bold text-slate-900 mb-4">Contact</h1>
        <p className="mb-8">Have a question, feedback, or need support? Reach out directly.</p>
        
        <img src="/social.png" alt="ZiptoGit App" className="w-full max-w-sm mx-auto h-auto rounded-xl shadow-sm border border-slate-100 mb-8" />
        
        <div className="inline-flex flex-col items-center gap-2 p-6 bg-slate-50 rounded-xl border border-slate-200">
          <span className="text-sm font-semibold text-slate-500 uppercase tracking-widest">Support Email</span>
          <a href="mailto:siteget1234@gmail.com" className="text-lg font-medium text-[#111827] hover:underline">siteget1234@gmail.com</a>
        </div>
      </div>
    </PageLayout>
  );
}

function HowItWorksPage() {
  return (
    <PageLayout title="How It Works">
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-md p-8 sm:p-12 text-slate-700">
        <h1 className="text-3xl font-bold text-slate-900 mb-6">How It Works</h1>
        <div className="space-y-6">
          <div className="flex gap-4">
            <div className="w-8 h-8 rounded-full bg-[#111827] text-white flex items-center justify-center font-bold shrink-0">1</div>
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Connect GitHub</h3>
              <p>Sign in with your GitHub account. This securely stores an OAuth token locally in your browser.</p>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="w-8 h-8 rounded-full bg-[#111827] text-white flex items-center justify-center font-bold shrink-0">2</div>
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Upload ZIP</h3>
              <p>Drag and drop your AI Studio ZIP export. The files are securely unzipped in your browser—nothing is sent to our servers.</p>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="w-8 h-8 rounded-full bg-[#111827] text-white flex items-center justify-center font-bold shrink-0">3</div>
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Sync Directly</h3>
              <p>We push the extracted files directly back into your selected repository using the GitHub API in one clean commit.</p>
            </div>
          </div>
        </div>
      </div>
    </PageLayout>
  );
}

function FAQPage() {
  const faqs = [
    { q: "Is my code secure?", a: "Yes. Your code never touches our servers. The ZIP extraction and standard GitHub API interactions happen entirely within your local browser runtime." },
    { q: "What does ZiptoGit cost?", a: "It is currently completely free to use." },
    { q: "Can I use it for private repositories?", a: "Yes. When you authenticate via OAuth, you grant the app access to read and commit to repositories you have permissions for." }
  ];

  return (
    <PageLayout title="FAQ">
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-md p-8 sm:p-12">
        <h1 className="text-3xl font-bold text-slate-900 mb-8 text-center">Frequently Asked Questions</h1>
        <div className="space-y-4">
          {faqs.map((faq, i) => (
            <div key={i} className="p-5 border border-slate-200 rounded-xl bg-slate-50">
              <h3 className="font-semibold text-slate-900 mb-2">{faq.q}</h3>
              <p className="text-slate-600 text-[14.5px] leading-relaxed">{faq.a}</p>
            </div>
          ))}
        </div>
      </div>
    </PageLayout>
  );
}

// --- Main App / Router --- //
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<PageLayout title="Home"><ZipUploader /></PageLayout>} />
        <Route path="/how-it-works" element={<HowItWorksPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/contact" element={<ContactPage />} />
      </Routes>
    </BrowserRouter>
  );
}

