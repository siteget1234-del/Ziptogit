/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from "react";
import { Github, Upload, CheckCircle2, Loader2, LogOut, Archive, FolderGit2 } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

export default function App() {
  const [token, setToken] = useState<string | null>(localStorage.getItem("github_token"));
  const [repos, setRepos] = useState<any[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "success" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Validate origin is from AI Studio preview or localhost.
      const origin = event.origin;
      if (!origin.endsWith('.run.app') && !origin.includes('localhost')) {
        return;
      }
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        const accessToken = event.data.token;
        setToken(accessToken);
        localStorage.setItem("github_token", accessToken);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    if (token) {
      fetchRepos();
    }
  }, [token]);

  const handleConnect = async () => {
    try {
      const redirectUri = `${window.location.origin}/auth/callback`;
      const response = await fetch(`/api/auth/url?redirectUri=${encodeURIComponent(redirectUri)}`);
      if (!response.ok) throw new Error('Failed to get auth URL');
      const { url } = await response.json();
      
      const authWindow = window.open(url, 'oauth_popup', 'width=600,height=700');
      if (!authWindow) {
        alert('Please allow popups for this site to connect your account.');
      }
    } catch (error) {
      console.error('OAuth error:', error);
      alert('Failed to initiate GitHub login.');
    }
  };

  const handleLogout = () => {
    setToken(null);
    setRepos([]);
    localStorage.removeItem("github_token");
    setUploadStatus("idle");
    setSelectedFile(null);
  };

  const fetchRepos = async () => {
    setIsLoadingRepos(true);
    try {
      const response = await fetch("/api/github/repos", {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        if (response.status === 401) {
          handleLogout();
        }
        throw new Error('Failed to fetch repos');
      }
      const data = await response.json();
      setRepos(data);
    } catch (error) {
      console.error(error);
    } finally {
      setIsLoadingRepos(false);
    }
  };

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (file.name.endsWith('.zip')) {
        setSelectedFile(file);
        setUploadStatus("idle");
      } else {
        alert("Please upload a .zip file");
      }
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      if (file.name.endsWith('.zip')) {
        setSelectedFile(file);
        setUploadStatus("idle");
      } else {
        alert("Please upload a .zip file");
      }
    }
  };

  const handleUpload = async () => {
    if (!selectedFile || !selectedRepo) return;
    
    setIsUploading(true);
    setUploadStatus("idle");
    setStatusMessage("Extracting and pushing to GitHub...");

    const [owner, repo] = selectedRepo.split('/');
    
    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("owner", owner);
    formData.append("repo", repo);
    formData.append("commitMessage", `Update from AI Studio via Zip Upload (${selectedFile.name})`);

    try {
      const response = await fetch("/api/github/push", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`
        },
        body: formData
      });

      const data = await response.json();

      if (response.ok) {
        setUploadStatus("success");
        setStatusMessage(`Successfully pushed to ${selectedRepo}`);
      } else {
        setUploadStatus("error");
        setStatusMessage(data.error || "Failed to push to GitHub");
      }
    } catch (error: any) {
      setUploadStatus("error");
      setStatusMessage(error.message || "An unexpected error occurred");
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-xl shadow-gray-200/50 overflow-hidden">
        <div className="p-8 border-b border-gray-100 bg-gray-900 text-white text-center">
          <div className="mx-auto w-12 h-12 bg-white/10 rounded-full flex items-center justify-center mb-4 ring-4 ring-white/5">
            <Github className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">ZiptoGit</h1>
          <p className="text-gray-400 mt-2 text-sm max-w-sm mx-auto">
            Upload any ZIP archive and push its extracted contents directly to your repositories—no Git CLI required.
          </p>
        </div>

        <div className="p-8">
          <AnimatePresence mode="wait">
            {!token ? (
              <motion.div
                key="login"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="text-center py-6"
              >
                <div className="mb-6 space-y-3">
                  <p className="text-gray-600 text-sm">
                    Connect your GitHub account to securely push zip contents directly to your repositories without needing a local Git environment.
                  </p>
                </div>
                <button
                  onClick={handleConnect}
                  className="inline-flex items-center justify-center gap-2 w-full px-6 py-3 bg-gray-900 text-white font-medium rounded-lg hover:bg-gray-800 transition-colors focus:ring-4 focus:ring-gray-200 outline-none"
                >
                  <Github className="w-5 h-5" />
                  Connect GitHub
                </button>
              </motion.div>
            ) : (
              <motion.div
                key="dashboard"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-6"
              >
                {/* Repositories */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm border-b border-transparent font-medium text-gray-700 flex items-center gap-2">
                      <FolderGit2 className="w-4 h-4 text-gray-400" />
                      Select Repository
                    </label>
                    <button onClick={handleLogout} className="text-xs text-gray-400 hover:text-red-500 flex items-center gap-1 transition-colors">
                      <LogOut className="w-3 h-3" />
                      Disconnect
                    </button>
                  </div>
                  <div className="relative">
                    <select
                      value={selectedRepo}
                      onChange={(e) => setSelectedRepo(e.target.value)}
                      disabled={isLoadingRepos || isUploading}
                      className="w-full pl-3 pr-10 py-3 bg-gray-50 border border-gray-200 rounded-lg appearance-none text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent transition-all disabled:opacity-50"
                    >
                      <option value="" disabled>
                        {isLoadingRepos ? "Loading repositories..." : "Choose a repository..."}
                      </option>
                      {repos.map((repo) => (
                        <option key={repo.id} value={repo.full_name}>
                          {repo.full_name}
                        </option>
                      ))}
                    </select>
                    <div className="absolute inset-y-0 right-3 flex items-center pointer-events-none">
                      {isLoadingRepos ? <Loader2 className="w-4 h-4 text-gray-400 animate-spin" /> : <ChevronDownIcon className="w-4 h-4 text-gray-400" />}
                    </div>
                  </div>
                </div>

                {/* File Upload Area */}
                <div className="space-y-2">
                   <label className="text-sm font-medium text-gray-700 flex items-center gap-2">
                      <Archive className="w-4 h-4 text-gray-400" />
                      ZIP Archive
                   </label>
                  <div
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={handleFileDrop}
                    onClick={() => !isUploading && fileInputRef.current?.click()}
                    className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer
                      ${selectedFile ? 'border-gray-900 bg-gray-50' : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'}
                      ${isUploading ? 'opacity-50 pointer-events-none' : ''}
                    `}
                  >
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileSelect}
                      accept=".zip"
                      className="hidden"
                    />
                    
                    {selectedFile ? (
                      <div className="flex flex-col items-center gap-2">
                        <div className="w-10 h-10 bg-gray-900 rounded-full flex items-center justify-center text-white mb-2">
                          <CheckCircle2 className="w-5 h-5" />
                        </div>
                        <p className="text-gray-900 font-medium truncate max-w-full px-4">{selectedFile.name}</p>
                        <p className="text-gray-500 text-xs">{(selectedFile.size / 1024 / 1024).toFixed(2)} MB</p>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2">
                        <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center text-gray-500 mb-2">
                          <Upload className="w-6 h-6" />
                        </div>
                        <p className="text-gray-900 font-medium font-sans">Click to upload or drag and drop</p>
                        <p className="text-gray-400 text-sm">Valid .zip archive</p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Status Message */}
                {uploadStatus !== "idle" && (
                   <motion.div 
                     initial={{ opacity: 0, height: 0 }}
                     animate={{ opacity: 1, height: 'auto' }}
                     className={`p-4 rounded-lg text-sm flex items-center gap-3 ${
                        uploadStatus === "success" ? 'bg-green-50 text-green-900 border border-green-100' : 'bg-red-50 text-red-900 border border-red-100'
                     }`}
                   >
                     {uploadStatus === "success" ? <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" /> : <div className="w-5 h-5 rounded-full bg-red-100 text-red-600 flex items-center justify-center font-bold text-xs shrink-0">!</div>}
                     <p>{statusMessage}</p>
                   </motion.div>
                )}

                {/* Submit Action */}
                <button
                  onClick={handleUpload}
                  disabled={!selectedFile || !selectedRepo || isUploading}
                  className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-gray-900 text-white font-medium rounded-lg hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all focus:ring-4 focus:ring-gray-200 outline-none"
                >
                  {isUploading ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Pushing to GitHub...
                    </>
                  ) : (
                    <>
                      Push to GitHub
                    </>
                  )}
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
   return (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
         <path d="m6 9 6 6 6-6"/>
      </svg>
   )
}
