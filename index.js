
import { GoogleGenAI, Type } from "@google/genai";
import html2canvas from 'html2canvas';

const uploadArea = document.getElementById('upload-area');
const videoUpload = document.getElementById('video-upload');
const videoPreview = document.getElementById('video-preview');
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


let videoFile = null;
let extractedFramesData = [];
let analysisResult = null;

const ai = new GoogleGenAI({ apiKey: "AIzaSyAkuDOerSFcd9iKspmSthRkHy6M5AzvNhw" });
const model = 'gemini-2.5-flash';

videoUpload.addEventListener('change', handleFileSelect);
uploadArea.addEventListener('dragover', handleDragOver);
uploadArea.addEventListener('dragleave', handleDragLeave);
uploadArea.addEventListener('drop', handleFileDrop);
analyzeButton.addEventListener('click', handleAnalyzeClick);
startOverButton.addEventListener('click', resetUI);
copyButton.addEventListener('click', copyResultsToClipboard);
shareButton.addEventListener('click', handleShareClick);
downloadButton.addEventListener('click', handleDownloadReportClick);

/**
 * Wraps the Gemini API call with an intelligent retry mechanism.
 * @param {object} request The request object for generateContent.
 * @param {object} options Options for retrying.
 * @param {number} options.maxRetries Maximum number of retries.
 * @param {number} options.initialDelay Starting delay in ms.
 * @param {function} options.onRetry Callback function when a retry occurs.
 * @returns {Promise<GenerateContentResponse>}
 */
async function generateContentWithRetry(request, options = {}) {
    const { maxRetries = 3, initialDelay = 1000, onRetry } = options;
    let delay = initialDelay;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await ai.models.generateContent(request);
        } catch (error) {
            // Check for a specific 503 "overloaded" error to retry.
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
                // Not a retryable error, re-throw immediately.
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
    if (!file.type.startsWith('video/')) {
        alert('Please upload a valid video file.');
        return;
    }
    videoFile = file;

    if (videoPreview.src) {
        URL.revokeObjectURL(videoPreview.src);
    }
    
    const videoURL = URL.createObjectURL(file);

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
            videoPreview.src = videoURL;
        });

        uploadArea.classList.add('hidden');
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


function handleDragOver(event) {
    event.preventDefault();
    uploadArea.classList.add('dragover');
}

function handleDragLeave(event) {
    event.preventDefault();
    uploadArea.classList.remove('dragover');
}

function resetUI() {
    videoFile = null;
    analysisResult = null;
    if (videoPreview.src) {
        URL.revokeObjectURL(videoPreview.src);
    }
    videoPreview.src = '';
    videoUpload.value = '';
    uploadArea.classList.remove('hidden');
    videoPreview.classList.remove('visible');
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
  if (!videoFile) {
    alert('Please select a video file first.');
    return;
  }

  setLoading(true, 'Extracting high-quality frames...');
  resetAnalysisUI();

  try {
    const frames = await extractFramesFromVideo(videoPreview, 10);
    displayFrames(frames);
    
    // Stage 1: Per-Frame Analysis
    const frameAnalysisResults = [];
    const frameAnalysisSchema = {
      type: Type.OBJECT,
      properties: {
        anomalies_found: {
          type: Type.BOOLEAN,
          description: "True if any visual anomalies were detected, otherwise false."
        },
        description: {
          type: Type.STRING,
          description: "A brief, one-sentence description of the most prominent anomaly or observation in the frame. If none, state that the frame appears natural."
        }
      },
      required: ["anomalies_found", "description"]
    };

    const frameAnalysisInstruction = "You are a forensic image analyst. Your task is to examine this single image for any signs of digital manipulation or AI generation. Focus on artifacts like unnatural textures (skin, background), lighting inconsistencies, and structural impossibilities. Report your findings concisely in the requested JSON format.";

    for (let i = 0; i < frames.length; i++) {
        const originalMessage = `Stage 1: Analyzing frame ${i + 1} of ${frames.length}...`;
        setLoading(true, originalMessage);
        
        const request = {
            model: model,
            contents: [{ parts: [
                { text: "Analyze the following image based on your instructions." },
                { inlineData: { mimeType: 'image/jpeg', data: frames[i].split(',')[1] }}
            ]}],
            config: {
                systemInstruction: frameAnalysisInstruction,
                responseMimeType: 'application/json',
                responseSchema: frameAnalysisSchema
            }
        };

        const response = await generateContentWithRetry(request, {
            onRetry: (attempt, max) => {
                 setLoading(true, `Frame ${i + 1}: Model busy, retrying... (${attempt}/${max})`);
            }
        });
        
        const resultText = response.text;
        const parsedResult = JSON.parse(resultText);
        frameAnalysisResults.push(`Frame ${i + 1}: ${parsedResult.description}`);
    }

    // Stage 2: Synthesis
    const synthesisOriginalMessage = 'Stage 2: Synthesizing findings...';
    setLoading(true, synthesisOriginalMessage);
    const synthesisInstruction = `You are a world-class lead digital forensics investigator. Your team of analysts has provided the following observations for 10 sequential frames from a video. Your task is to perform a differential analysis and produce a final, conclusive report.

**Core Directives:**
1.  **Analyze Holistically:** Review all analyst reports to identify patterns, especially temporal inconsistencies between frames.
2.  **Identify Key Indicators:** From the evidence, you MUST identify the single strongest piece of evidence suggesting the video is **AI Generated** and the single strongest piece of evidence suggesting it is **Authentic**. If no strong evidence exists for one side, state "None found."
3.  **Weigh the Evidence:** In your final synthesis, you MUST explain how you weighed these two key indicators against each other to arrive at your conclusion. For example, is temporal instability (flickering background) more significant than consistent lighting?
4.  **Render a Decisive Verdict:** Based on this weighing of evidence, provide a verdict. It MUST be one of: 'AI Generated', 'Authentic Video', or 'Inconclusive'. Use 'Inconclusive' only when the key indicators are of equal and contradictory weight.

**Final output must be a JSON object adhering strictly to the provided schema.**`;

    const synthesisSchema = {
        type: Type.OBJECT,
        properties: {
            verdict: {
                type: Type.STRING,
                description: "The final verdict. Must be one of: 'AI Generated', 'Authentic Video', 'Inconclusive'."
            },
            confidence_score: {
                type: Type.STRING,
                description: "Your confidence in the verdict as a percentage (e.g., '95%')."
            },
            key_evidence_for_ai: {
                type: Type.STRING,
                description: "A brief description of the single most compelling piece of evidence suggesting AI generation. State 'None found' if applicable."
            },
            key_evidence_for_real: {
                type: Type.STRING,
                description: "A brief description of the single most compelling piece of evidence suggesting the video is authentic. State 'None found' if applicable."
            },
            final_synthesis: {
                type: Type.STRING,
                description: "A concise, final analysis explaining how you weighed the key evidence to reach your verdict."
            }
        },
        required: ['verdict', 'confidence_score', 'key_evidence_for_ai', 'key_evidence_for_real', 'final_synthesis']
    };

    const synthesisPrompt = `Here are the frame-by-frame analysis reports:\n${frameAnalysisResults.join('\n')}\n\nNow, generate the final, synthesized forensic report in JSON format.`;
    
    const finalRequest = {
      model: model,
      contents: [{ parts: [{text: synthesisPrompt}] }],
      config: {
        systemInstruction: synthesisInstruction,
        responseMimeType: 'application/json',
        responseSchema: synthesisSchema
      }
    };

    const finalResponse = await generateContentWithRetry(finalRequest, {
         onRetry: (attempt, max) => {
            setLoading(true, `Synthesis: Model busy, retrying... (${attempt}/${max})`);
        }
    });

    let parsedData = null;
    try {
        const fullText = finalResponse.text;
        parsedData = JSON.parse(fullText);
        analysisResult = parsedData;
    } catch(e) {
        console.error("Failed to parse JSON response from AI", e, finalResponse.text);
    }

    if (parsedData) {
        resultDiv.classList.remove('hidden');
        displayResult(parsedData);
    } else {
        resultDiv.classList.remove('hidden');
        resultVerdict.textContent = 'Error';
        resultReasoning.textContent = "The AI model returned an empty or invalid response during the final synthesis. This may be due to a content safety policy or a network issue.";
        resultDiv.classList.add('result-uncertain');
    }

  } catch (error) {
    console.error('Error during analysis:', error);
    resultDiv.classList.remove('hidden');
    resultVerdict.textContent = 'Analysis Error';
    resultReasoning.textContent = `An error occurred: ${error.message}. Please try a different video.`;
    resultDiv.classList.add('result-uncertain');
  } finally {
    setLoading(false);
    analyzeButton.classList.add('hidden');
    startOverButton.classList.remove('hidden');
  }
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

function displayResult(result) {
    const { verdict, confidence_score, key_evidence_for_ai, key_evidence_for_real, final_synthesis } = result;

    resultVerdict.textContent = verdict;
    resultConfidence.textContent = confidence_score;
    resultConfidence.classList.remove('hidden');

    const reasoningHtml = `
      <p>${final_synthesis}</p>
      <ul class="forensic-findings-list">
        <li>
          <strong>Key Evidence for AI Generation</strong>
          <p>${key_evidence_for_ai}</p>
        </li>
        <li>
          <strong>Key Evidence for Authentic Video</strong>
          <p>${key_evidence_for_real}</p>
        </li>
      </ul>
    `;

    resultReasoning.innerHTML = reasoningHtml;
    
    toggleReasoningButton.classList.add('hidden');
    
    resultDiv.classList.remove('result-ai', 'result-authentic', 'result-uncertain');
    if (verdict === 'AI Generated') {
        resultDiv.classList.add('result-ai');
    } else if (verdict === 'Authentic Video') {
        resultDiv.classList.add('result-authentic');
    } else { // 'Inconclusive'
        resultDiv.classList.add('result-uncertain');
    }
}

async function copyResultsToClipboard() {
    if (!analysisResult) return;

    const { verdict, confidence_score, final_synthesis, key_evidence_for_ai, key_evidence_for_real } = analysisResult;
    
    const textToCopy = `Verdict: ${verdict} (${confidence_score})\n\nFinal Synthesis: ${final_synthesis}\n\n- Key Evidence for AI Generation: ${key_evidence_for_ai}\n- Key Evidence for Authentic Video: ${key_evidence_for_real}`;
    try {
        await navigator.clipboard.writeText(textToCopy);
        const originalIcon = copyButton.innerHTML;
        copyButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
        setTimeout(() => {
            copyButton.innerHTML = originalIcon;
        }, 2000);
    } catch (err) {
        console.error('Failed to copy text: ', err);
    }
}

async function handleShareClick() {
    try {
        resultDiv.classList.add('capturing');
        const canvas = await html2canvas(resultDiv, {
             backgroundColor: '#1e1e1e',
             useCORS: true,
             scale: 2
        });
        resultDiv.classList.remove('capturing');

        const imageURL = canvas.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = imageURL;
        a.download = 'ai-video-analysis.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    } catch (error) {
        console.error('Failed to generate image:', error);
        alert('Could not generate image. Please try again.');
    }
}

function handleDownloadReportClick() {
    if (!analysisResult || extractedFramesData.length === 0) {
        alert('No analysis results to download.');
        return;
    }

    const { verdict, confidence_score, final_synthesis, key_evidence_for_ai, key_evidence_for_real } = analysisResult;

    const findingsHtml = `
        <ul>
            <li><strong>Key Evidence for AI Generation:</strong> ${key_evidence_for_ai}</li>
            <li><strong>Key Evidence for Authentic Video:</strong> ${key_evidence_for_real}</li>
        </ul>
    `;
    
    const framesHtml = extractedFramesData.map(frame => 
        `<img src="${frame}" alt="Analyzed Frame" style="width: 100%; max-width: 200px; border-radius: 8px; margin: 5px; border: 1px solid #ddd;">`
    ).join('');

    const reportHtml = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>AI Video Analysis Report</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 2rem auto; padding: 2rem; border: 1px solid #eee; border-radius: 12px; }
                h1, h2, h3 { color: #111; }
                .result { border: 1px solid #ddd; padding: 1.5rem; border-radius: 12px; margin-bottom: 2rem; }
                .result p { margin-top: 0; }
                .result ul { padding-left: 20px; }
                .frames { margin-top: 2rem; }
                .frames-grid { display: flex; flex-wrap: wrap; gap: 10px; }
            </style>
        </head>
        <body>
            <h1>AI Video Analysis Report</h1>
            <div class="result">
                <h2>Forensic Analysis</h2>
                <p><strong>Verdict:</strong> ${verdict} (${confidence_score})</p>
                <p><strong>Final Synthesis:</strong> ${final_synthesis}</p>
                <h3>Key Evidence</h3>
                ${findingsHtml}
            </div>
            <div class="frames">
                <h2>Analyzed Frames</h2>
                <div class="frames-grid">${framesHtml}</div>
            </div>
        </body>
        </html>
    `;

    const blob = new Blob([reportHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ai-video-analysis-report.html';
    document.body.appendChild(a);
a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function extractFramesFromVideo(video, frameCount) {
  return new Promise(async (resolve, reject) => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const frames = [];
    
    if (video.readyState < 1) {
      await new Promise(res => video.addEventListener('loadedmetadata', res, { once: true }));
    }
    
    const duration = video.duration;

    if (!context || !duration || isNaN(duration) || duration === Infinity) {
      reject(new Error('Invalid video metadata. The video may be corrupt or in an unsupported format.'));
      return;
    }

    video.pause();
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    let framesExtracted = 0;
    
    const onSeeked = async () => {
      if (framesExtracted < frameCount) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push(canvas.toDataURL('image/jpeg', 0.9));
        framesExtracted++;

        if (framesExtracted < frameCount) {
            const nextTime = (duration / (frameCount + 1)) * (framesExtracted + 1);
            video.currentTime = nextTime;
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
    if (videoFile) {
        analyzeButton.disabled = false;
    }
    analyzeButton.textContent = 'Analyze Video';
  }
}