import express from "express";
import runGraph from "./ai/graph.ai.js";
import { mistralAIModel, cohereModel, geminiModel } from "./ai/models.ai.js";
import { run } from "node:test";
import { success } from "zod";
import cors from "cors"
import z from "zod";
import { HumanMessage } from "langchain";

const app = express();
app.use(express.json())
app.use(cors({
    origin:["http://localhost:5173", "http://localhost:5174"],
    methods:["GET","POST"],
    credentials:true
}))

// Helper to extract text from LangChain message/chunk or string
function extractContent(response: any): string {
    // Handle string directly
    if (typeof response === 'string') {
        return response;
    }
    
    if (typeof response === 'object' && response !== null) {
        // LangChain AIMessageChunk or AIMessage - priority: content property
        if (response.content !== undefined && response.content !== null) {
            // If content is a string, return it directly
            if (typeof response.content === 'string') {
                return response.content;
            }
            
            // If content is an array, join them
            if (Array.isArray(response.content)) {
                return response.content
                    .map((c: any) => typeof c === 'string' ? c : c?.text || c?.content || '')
                    .filter((s: string) => s.length > 0)
                    .join('');
            }
        }
        
        // Fallback for other properties
        if (response.text && typeof response.text === 'string') {
            return response.text;
        }
        
        if (response.output && typeof response.output === 'string') {
            return response.output;
        }
        
        if (response.message && typeof response.message === 'string') {
            return response.message;
        }
    }
    
    // Empty string for null/undefined values
    return '';
}

// Judge function
async function runJudge(problem: string, solution_1: string, solution_2: string) {
    const judgeSchema = z.object({
        solution_1_score: z.number().min(0).max(10),
        solution_2_score: z.number().min(0).max(10),
        solution_1_reasoning: z.string().default(""),
        solution_2_reasoning: z.string().default("")
    });

    const judge = geminiModel.withStructuredOutput(judgeSchema);

    const judgeResponse = await judge.invoke([
        new HumanMessage(`You are a judge tasked with evaluating two solutions to the following problem: ${problem}. Please provide a score between 0 and 10 for each solution, along with your reasoning.
            
Solution 1: ${solution_1}
Solution 2: ${solution_2}

Please evaluate the two solutions and provide scores and reasoning.`)
    ])

    return judgeResponse;
}

app.get("/",async (req,res)=>{
    const result = await runGraph("write a code for fibonacci sequence")
    res.json(result)
})

// Test endpoint for streaming verification
app.get("/test-stream", (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    const testData = "This is a test streaming message to verify streaming works correctly in your application.";
    const chunkSize = 10;
    
    (async () => {
        for (let i = 0; i < testData.length; i += chunkSize) {
            const chunk = testData.substring(i, i + chunkSize);
            res.write(`data: ${JSON.stringify({chunk: chunk})}\n\n`);
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        res.write(`data: ${JSON.stringify({done: true})}\n\n`);
        res.end();
    })();
})

app.post("/invoke",async (req,res)=>{
    const{problem}=req.body
    console.log('📥 Received problem:', problem);
    
    // Set headers for streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    try {
        console.log('🚀 Starting real-time model streaming...');
        
        let solution1 = '';
        let solution2 = '';
        
        // Stream solution 1 in real-time
        console.log('⏳ Starting Solution 1 streaming...');
        const stream1 = await mistralAIModel.stream(problem);
        
        for await (const chunk of stream1) {
            const content = extractContent(chunk);
            if (content) {
                solution1 += content;
                res.write(`data: ${JSON.stringify({solution_1_chunk: content})}\n\n`);
                console.log('📝 Solution 1 chunk streamed:', content.length, 'chars');
            }
        }
        
        console.log('✅ Solution 1 streaming complete, total:', solution1.length, 'chars');
        
        // Small delay between solutions
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Stream solution 2 in real-time
        console.log('⏳ Starting Solution 2 streaming...');
        const stream2 = await cohereModel.stream(problem);
        
        for await (const chunk of stream2) {
            const content = extractContent(chunk);
            if (content) {
                solution2 += content;
                res.write(`data: ${JSON.stringify({solution_2_chunk: content})}\n\n`);
                console.log('📝 Solution 2 chunk streamed:', content.length, 'chars');
            }
        }
        
        console.log('✅ Solution 2 streaming complete, total:', solution2.length, 'chars');
        console.log('⚖️ Running judge...');
        
        // Run judge on complete solutions
        const judge = await runJudge(problem, solution1, solution2);
        
        console.log('✅ Judge verdict ready');
        
        // Send judge verdict with problem
        res.write(`data: ${JSON.stringify({judge, solution_1: solution1, solution_2: solution2, problem})}\n\n`);
        res.write(`data: [DONE]\n\n`);
        res.end();
    } catch (error: any) {
        console.error('❌ API error:', error);
        const errorMessage = error?.message || String(error) || 'Unknown error';
        res.write(`data: ${JSON.stringify({error: errorMessage})}\n\n`);
        res.end();
    }
})
export default app