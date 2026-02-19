import { GoogleGenAI, Type } from "@google/genai";
import html2canvas from 'html2canvas';

const uploadArea = document.getElementById('upload-area');
const mediaUpload = document.getElementById('media-upload');
const videoPreview = document.getElementById('video-preview');
const audioPreview = document.getElementById('audio-preview');
const analyzeButton = document.getElementById('analyze-button');
const startOverButton = document.getElementById('start-over-button');
const loader = document.getElementById('loader');
const loaderText = document.getElementById('loader-text');

const framesContainerWrapper = document.getElementById('frames-container-wrapper');
const framesContainer = document.getElementById('frames-container');
const resultDiv = document.getElementById('result');
const resultVerdict = document.getElementById('result-verdict');
const resultConfidence = document.getElementById('result-confidence');
const resultReasoning = document.getElementById('result-reasoning');
const toggleReasoningButton = document.getElementById('toggle-reasoning-button');
const copyButton = document.getElementById('copy-button');
const shareButton = document.getElementById('share-button');
const downloadButton = document.getElementById('download-button');


let mediaFile = null;
let currentFileType = null; 
let extractedFramesData = [];
let analysisResult = null;

const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_API_KEY });
const model = 'gemini-2.5-flash';

mediaUpload.addEventListener('change', handleFileSelect);
uploadArea.addEventListener('dragover', handleDragOver);
uploadArea.addEventListener('dragleave', handleDragLeave);
uploadArea.addEventListener('drop', handleFileDrop);
analyzeButton.addEventListener('click', handleAnalyzeClick);
startOverButton.addEventListener('click', resetUI);
copyButton.addEventListener('click', copyResultsToClipboard);
shareButton.addEventListener('click', handleShareClick);
downloadButton.addEventListener('click', handleDownloadReportClick);

async function generateContentWithRetry(request, options = {}) {
    const { maxRetries = 3, initialDelay = 1000, onRetry } = options;
    let delay = initialDelay;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await ai.models.generateContent(request);
        } catch (error) {
            if (error.message.includes('503') || error.message.toLowerCase().includes('overloaded')) {
                if (i === maxRetries - 1) {
                    throw new Error(`The model is overloaded and failed to respond after ${maxRetries} attempts.`);
                }
                if (onRetry) {
                    onRetry(i + 1, maxRetries);
                }
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; // Exponential backoff
            } else {
                throw error;
            }
        }
    }
}


function handleFileSelect(event) {
  const target = event.target;
  const files = target.files;
  if (files && files.length > 0) {
    processFile(files[0]);
  }
}

function handleFileDrop(event) {
    event.preventDefault();
    uploadArea.classList.remove('dragover');
    if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
        processFile(event.dataTransfer.files[0]);
        event.dataTransfer.clearData();
    }
}

async function processFile(file) {
    if (file.type.startsWith('video/')) {
        currentFileType = 'video';
        await processVideoFile(file);
    } else if (file.type.startsWith('audio/')) {
        currentFileType = 'audio';
        processAudioFile(file);
    } else {
        alert('Please upload a valid video or audio file.');
        return;
    }
}

async function processVideoFile(file) {
    mediaFile = file;
    if (videoPreview.src) URL.revokeObjectURL(videoPreview.src);
    const fileURL = URL.createObjectURL(file);
    try {
        await new Promise((resolve, reject) => {
            const handleCanPlay = () => {
                videoPreview.removeEventListener('canplay', handleCanPlay);
                videoPreview.removeEventListener('error', handleError);
                resolve();
            };
            const handleError = () => {
                videoPreview.removeEventListener('canplay', handleCanPlay);
                videoPreview.removeEventListener('error', handleError);
                reject(new Error('The video file could not be loaded. It might be corrupt or in an unsupported format.'));
            };
            videoPreview.addEventListener('canplay', handleCanPlay);
            videoPreview.addEventListener('error', handleError);
            videoPreview.src = fileURL;
        });

        uploadArea.classList.add('hidden');
        audioPreview.classList.remove('visible');
        videoPreview.classList.add('visible');
        videoPreview.currentTime = 0;
        analyzeButton.disabled = false;
        resetAnalysisUI();
        
    } catch (err) {
        console.error(err.message);
        alert(err.message);
        resetUI();
    }
}

function processAudioFile(file) {
    mediaFile = file;
    if (audioPreview.src) URL.revokeObjectURL(audioPreview.src);
    audioPreview.src = URL.createObjectURL(file);
    uploadArea.classList.add('hidden');
    videoPreview.classList.remove('visible');
    audioPreview.classList.add('visible');
    analyzeButton.disabled = false;
    resetAnalysisUI();
}


function handleDragOver(event) {
    event.preventDefault();
    uploadArea.classList.add('dragover');
}

function handleDragLeave(event) {
    event.preventDefault();
    uploadArea.classList.remove('dragover');
}

function resetUI() {
    mediaFile = null;
    analysisResult = null;
    currentFileType = null;

    if (videoPreview.src) URL.revokeObjectURL(videoPreview.src);
    if (audioPreview.src) URL.revokeObjectURL(audioPreview.src);

    videoPreview.src = '';
    audioPreview.src = '';
    mediaUpload.value = '';

    uploadArea.classList.remove('hidden');
    videoPreview.classList.remove('visible');
    audioPreview.classList.remove('visible');
    
    analyzeButton.classList.remove('hidden');
    startOverButton.classList.add('hidden');
    analyzeButton.disabled = true;
    resetAnalysisUI();
}

function resetAnalysisUI() {
    resultDiv.classList.add('hidden');
    resultDiv.classList.remove('result-ai', 'result-authentic', 'result-uncertain');
    framesContainerWrapper.classList.add('hidden');
    framesContainer.innerHTML = '';
    extractedFramesData = [];
    toggleReasoningButton.classList.add('hidden');
}

async function handleAnalyzeClick() {
  if (!mediaFile) return;

  analyzeButton.classList.add('hidden');
  startOverButton.classList.add('hidden');

  try {
      if (currentFileType === 'video') {
          await analyzeVideo();
      } else if (currentFileType === 'audio') {
          await analyzeAudio();
      }
  } catch (error) {
      console.error('Error during analysis:', error);
      resultDiv.classList.remove('hidden');
      resultVerdict.textContent = 'Analysis Error';
      resultReasoning.textContent = `An error occurred: ${error.message}. Please try a different file.`;
      resultDiv.classList.add('result-uncertain');
  } finally {
      setLoading(false);
      startOverButton.classList.remove('hidden');
  }
}

async function analyzeVideo() {
    setLoading(true, 'Extracting high-quality frames...');
    resetAnalysisUI();
    const frames = await extractFramesFromVideo(videoPreview, 10);
    displayFrames(frames);
    
    const frameAnalysisResults = [];
    const frameAnalysisSchema = { type: Type.OBJECT, properties: { anomalies_found: { type: Type.BOOLEAN }, description: { type: Type.STRING } }, required: ["anomalies_found", "description"] };
    const frameAnalysisInstruction = "You are a forensic image analyst. Examine this single image for signs of digital manipulation or AI generation. Focus on unnatural textures, lighting inconsistencies, and structural impossibilities. Report findings concisely in JSON.";

    for (let i = 0; i < frames.length; i++) {
        setLoading(true, `Stage 1: Analyzing frame ${i + 1} of ${frames.length}...`);
        const request = { model, contents: [{ parts: [ { text: "Analyze the following image." }, { inlineData: { mimeType: 'image/jpeg', data: frames[i].split(',')[1] }} ]}], config: { systemInstruction: frameAnalysisInstruction, responseMimeType: 'application/json', responseSchema: frameAnalysisSchema } };
        const response = await generateContentWithRetry(request, { onRetry: (attempt, max) => setLoading(true, `Frame ${i + 1}: Model busy, retrying... (${attempt}/${max})`) });
        const parsedResult = JSON.parse(response.text);
        frameAnalysisResults.push(`Frame ${i + 1}: ${parsedResult.description}`);
    }

    setLoading(true, 'Stage 2: Synthesizing findings...');
    const synthesisInstruction = `You are a lead digital forensics investigator. Review these 10 sequential frame analysis reports. Perform a differential analysis.
    1. Identify the single strongest evidence for 'AI Generated' and for 'Authentic Video'.
    2. Explain how you weighed these indicators to reach a conclusion.
    3. Render a final verdict: 'AI Generated', 'Authentic Video', or 'Inconclusive'.
    Output a JSON object using the provided schema.`;
    const synthesisSchema = { type: Type.OBJECT, properties: { verdict: { type: Type.STRING }, confidence_score: { type: Type.STRING }, key_evidence_for_ai: { type: Type.STRING }, key_evidence_for_real: { type: Type.STRING }, final_synthesis: { type: Type.STRING } }, required: ['verdict', 'confidence_score', 'key_evidence_for_ai', 'key_evidence_for_real', 'final_synthesis'] };
    const synthesisPrompt = `Frame reports:\n${frameAnalysisResults.join('\n')}\n\nGenerate the final forensic report in JSON.`;
    const finalRequest = { model, contents: [{ parts: [{text: synthesisPrompt}] }], config: { systemInstruction: synthesisInstruction, responseMimeType: 'application/json', responseSchema: synthesisSchema } };
    const finalResponse = await generateContentWithRetry(finalRequest, { onRetry: (attempt, max) => setLoading(true, `Synthesis: Model busy, retrying... (${attempt}/${max})`) });
    
    const parsedData = JSON.parse(finalResponse.text);
    analysisResult = parsedData;
    displayResult(parsedData, 'video');
}

async function analyzeAudio() {
    setLoading(true, 'Analyzing audio...');
    resetAnalysisUI();
    
    const fileToBase64 = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = error => reject(error);
    });

    const audioData = await fileToBase64(mediaFile);

    const audioAnalysisInstruction = `You are a world-class forensic audio analyst. Analyze this audio clip for signs of AI-generated speech. Focus on unnatural cadence, lack of breaths, uniform pitch, or metallic artifacts.
    1. Identify the single strongest evidence for 'AI Generated' and for 'Authentic Audio'.
    2. Explain how you weighed these indicators.
    3. Render a final verdict: 'AI Generated', 'Authentic Audio', or 'Inconclusive'.
    Output a JSON object using the provided schema.`;

    const audioAnalysisSchema = {
        type: Type.OBJECT,
        properties: {
            verdict: { type: Type.STRING, description: "Must be 'AI Generated', 'Authentic Audio', or 'Inconclusive'." },
            confidence_score: { type: Type.STRING },
            key_evidence_for_ai: { type: Type.STRING },
            key_evidence_for_real: { type: Type.STRING, description: "Evidence for authentic audio." },
            final_synthesis: { type: Type.STRING }
        },
        required: ['verdict', 'confidence_score', 'key_evidence_for_ai', 'key_evidence_for_real', 'final_synthesis']
    };

    const request = {
        model,
        contents: [{ parts: [
            { text: "Analyze this audio file." },
            { inlineData: { mimeType: mediaFile.type, data: audioData }}
        ]}],
        config: {
            systemInstruction: audioAnalysisInstruction,
            responseMimeType: 'application/json',
            responseSchema: audioAnalysisSchema
        }
    };
    
    const response = await generateContentWithRetry(request, {
        onRetry: (attempt, max) => setLoading(true, `Audio analysis: Model busy, retrying... (${attempt}/${max})`)
    });

    const parsedData = JSON.parse(response.text);
    analysisResult = parsedData;
    displayResult(parsedData, 'audio');
}

function displayFrames(frames) {
    extractedFramesData = frames;
    framesContainerWrapper.classList.remove('hidden');
    frames.forEach(frame => {
        const img = document.createElement('img');
        img.src = frame;
        img.alt = 'Extracted video frame';
        framesContainer.appendChild(img);
    });
}

function displayResult(result, fileType) {
    resultDiv.classList.remove('hidden');
    const { verdict, confidence_score, key_evidence_for_ai, key_evidence_for_real, final_synthesis } = result;

    resultVerdict.textContent = verdict;
    resultConfidence.textContent = confidence_score;
    
    const evidenceForRealLabel = fileType === 'video' ? 'Key Evidence for Authentic Video' : 'Key Evidence for Authentic Audio';

    const reasoningHtml = `
      <p>${final_synthesis}</p>
      <ul class="forensic-findings-list">
        <li>
          <strong>Key Evidence for AI Generation</strong>
          <p>${key_evidence_for_ai}</p>
        </li>
        <li>
          <strong>${evidenceForRealLabel}</strong>
          <p>${key_evidence_for_real}</p>
        </li>
      </ul>
    `;
    resultReasoning.innerHTML = reasoningHtml;
    
    resultDiv.classList.remove('result-ai', 'result-authentic', 'result-uncertain');
    if (verdict === 'AI Generated') {
        resultDiv.classList.add('result-ai');
    } else if (verdict.includes('Authentic')) {
        resultDiv.classList.add('result-authentic');
    } else { // 'Inconclusive'
        resultDiv.classList.add('result-uncertain');
    }
}

async function copyResultsToClipboard() {
    if (!analysisResult) return;
    const { verdict, confidence_score, final_synthesis, key_evidence_for_ai, key_evidence_for_real } = analysisResult;
    const evidenceType = currentFileType === 'video' ? 'Authentic Video' : 'Authentic Audio';
    const textToCopy = `Verdict: ${verdict} (${confidence_score})\n\nFinal Synthesis: ${final_synthesis}\n\n- Key Evidence for AI Generation: ${key_evidence_for_ai}\n- Key Evidence for ${evidenceType}: ${key_evidence_for_real}`;
    try {
        await navigator.clipboard.writeText(textToCopy);
        const originalIcon = copyButton.innerHTML;
        copyButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
        setTimeout(() => { copyButton.innerHTML = originalIcon; }, 2000);
    } catch (err) {
        console.error('Failed to copy text: ', err);
    }
}

async function handleShareClick() {
    try {
        resultDiv.classList.add('capturing');
        const canvas = await html2canvas(resultDiv, { backgroundColor: '#1e1e1e', useCORS: true, scale: 2 });
        resultDiv.classList.remove('capturing');
        const imageURL = canvas.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = imageURL;
        a.download = `media-forensic-lab-${currentFileType}-analysis.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    } catch (error) {
        console.error('Failed to generate image:', error);
        alert('Could not generate image. Please try again.');
    }
}

function handleDownloadReportClick() {
    if (!analysisResult) return;
    const { verdict, confidence_score, final_synthesis, key_evidence_for_ai, key_evidence_for_real } = analysisResult;
    const evidenceType = currentFileType === 'video' ? 'Authentic Video' : 'Authentic Audio';

    const findingsHtml = `<ul><li><strong>Key Evidence for AI Generation:</strong> ${key_evidence_for_ai}</li><li><strong>Key Evidence for ${evidenceType}:</strong> ${key_evidence_for_real}</li></ul>`;
    
    const framesHtml = currentFileType === 'video' ? extractedFramesData.map(frame => 
        `<img src="${frame}" alt="Analyzed Frame" style="width: 100%; max-width: 200px; border-radius: 8px; margin: 5px; border: 1px solid #ddd;">`
    ).join('') : '';
    
    const framesSection = currentFileType === 'video' ? `<div class="frames"><h2>Analyzed Frames</h2><div class="frames-grid">${framesHtml}</div></div>` : '';

    const reportHtml = `
        <!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Media Forensic Lab Analysis Report</title>
        <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.6;color:#333;max-width:800px;margin:2rem auto;padding:2rem;border:1px solid #eee;border-radius:12px;}h1,h2{color:#111;}.result{border:1px solid #ddd;padding:1.5rem;border-radius:12px;margin-bottom:2rem;}.frames-grid{display:flex;flex-wrap:wrap;gap:10px;}</style></head>
        <body><h1>Media Forensic Lab: ${currentFileType.charAt(0).toUpperCase() + currentFileType.slice(1)} Analysis Report</h1><div class="result"><h2>Forensic Analysis</h2><p><strong>Verdict:</strong> ${verdict} (${confidence_score})</p><p><strong>Final Synthesis:</strong> ${final_synthesis}</p><h3>Key Evidence</h3>${findingsHtml}</div>${framesSection}</body></html>`;

    const blob = new Blob([reportHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `media-forensic-lab-${currentFileType}-analysis-report.html`;
    document.body.appendChild(a);
a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function extractFramesFromVideo(video, frameCount) {
  return new Promise(async (resolve, reject) => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return reject(new Error('Canvas context could not be created.'));
    
    if (video.readyState < 1) await new Promise(res => video.addEventListener('loadedmetadata', res, { once: true }));
    
    const duration = video.duration;
    if (!duration || isNaN(duration) || duration === Infinity) return reject(new Error('Invalid video metadata.'));

    video.pause();
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    const frames = [];
    let framesExtracted = 0;
    const onSeeked = async () => {
      if (framesExtracted < frameCount) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push(canvas.toDataURL('image/jpeg', 0.9));
        framesExtracted++;
        if (framesExtracted < frameCount) {
            video.currentTime = (duration / (frameCount + 1)) * (framesExtracted + 1);
        } else {
            video.removeEventListener('seeked', onSeeked);
            resolve(frames);
        }
      }
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = duration / (frameCount + 1);
  });
}

function setLoading(isLoading, message = 'Analyzing...') {
  if (isLoading) {
    loader.classList.remove('hidden');
    loaderText.textContent = message;
    analyzeButton.disabled = true;
    analyzeButton.textContent = 'Analyzing...';
  } else {
    loader.classList.add('hidden');
    if (mediaFile) analyzeButton.disabled = false;
    analyzeButton.textContent = 'Analyze';
  }
}