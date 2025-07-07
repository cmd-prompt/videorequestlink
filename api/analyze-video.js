// api/analyze-video.js
import { GoogleGenAI, createUserContent, createPartFromUri } from "@google/genai";
import formidable from 'formidable';
import fs from 'fs';
import path from 'path';

// Disable body parsing for multipart/form-data
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Parse the multipart form data
    const form = formidable({
      uploadDir: '/tmp', // Use /tmp directory in serverless environment
      keepExtensions: true,
      maxFileSize: 100 * 1024 * 1024, // 100MB limit
    });

    const [fields, files] = await form.parse(req);
    
    const videoFile = files.video?.[0];
    if (!videoFile) {
      return res.status(400).json({ error: 'No video file uploaded.' });
    }

    console.log(`Received video file: ${videoFile.originalFilename}`);
    console.log(`File saved temporarily at: ${videoFile.filepath}`);
    console.log(`File MIME type: ${videoFile.mimetype}`);
    console.log(`File size: ${videoFile.size} bytes`);

    // Initialize Google AI with API key from environment variable
    const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY });

    // Read the video file and upload to Google AI
    const fileBuffer = fs.readFileSync(videoFile.filepath);
    
    const myfile = await ai.files.upload({
      file: fileBuffer,
      config: { 
        mimeType: videoFile.mimetype || "video/mp4",
        displayName: videoFile.originalFilename || "video.mp4"
      },
    });

    // Wait for file to be processed
    let file = myfile;
    for (let i = 0; i < 30; i++) {
      const fileStatus = await ai.files.get(file.name);
      if (fileStatus.state === "ACTIVE") {
        file = fileStatus;
        break;
      }
      console.log(`Waiting for file to be ACTIVE... (${fileStatus.state})`);
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (file.state !== "ACTIVE") {
      throw new Error("File processing timed out");
    }

    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash-exp",
      contents: createUserContent([
        createPartFromUri(file.uri, file.mimeType),
        `
        This is a video of me. You are an expert in gesture detection and I'm building a gesture detection add-on tool for Adobe.
        The available gestures are: thumbs_up_left, thumbs_up_right, thumbs_down_left, thumbs_down_right, shocked, smile, frown, waving.

        Please analyze the video and provide a JSON output with the following structure for each detected gesture:

        {
            "gestures": [
            {
                "start_timestamp": "HH:mm:ss.SSS",
                "end_timestamp": "HH:mm:ss.SSS",
                "type": "waving", // thumbs_up_left, thumbs_up_right, thumbs_down_left, thumbs_down_right, shocked, smile, frown, waving, clap
                "position_x": XXX, // the X coordinate of the emoji, an effect will be used to overlay the video in this position
                "position_y": YYY, // the Y coordinate of the emoji, an effect will be used to overlay the video in this position
            },
            ]
        }

        Ensure the timestamps are in the "minutes:seconds.milliseconds" format. The only output you will give is the raw JSON, dont put it inside of a code block.
        `,
      ]),
    });

    console.log(response.text);
    
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(response.text);
    } catch (jsonError) {
      console.warn("Gemini did not return valid JSON. Returning raw text.", jsonError);
      return res.status(500).json({
        error: "Gemini AI did not return valid JSON format.",
        rawGeminiResponse: response.text
      });
    }

    // Clean up the uploaded file
    try {
      fs.unlinkSync(videoFile.filepath);
      console.log(`Temporary file ${videoFile.filepath} deleted.`);
    } catch (cleanupError) {
      console.error('Error deleting temporary file:', cleanupError);
    }

    // Clean up the uploaded file from Google AI (optional)
    try {
      await ai.files.delete(file.name);
      console.log(`File ${file.name} deleted from Google AI.`);
    } catch (deleteError) {
      console.error('Error deleting file from Google AI:', deleteError);
    }

    res.json(parsedResponse);

  } catch (error) {
    console.error('Error in analyze-video endpoint:', error);
    res.status(500).json({ error: 'Failed to process video upload.' });
  }
}