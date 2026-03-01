import modal
from pydantic import BaseModel
from typing import Optional

app = modal.App("akawa-llm-intelligence")

vllm_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "vllm==0.5.5",
        "hf-transfer==0.1.8"
    )
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
)

MODEL_NAME = "EleutherAI/gpt-neox-20b"
MODEL_DIR = "/model_cache"
model_volume = modal.Volume.from_name("akawa-llm-weights", create_if_missing=True)

class GenerateRequest(BaseModel):
    input_text: Optional[str] = None
    prompt: Optional[str] = None
    max_tokens: int = 512
    temperature: float = 0.7

class GenerateResponse(BaseModel):
    report: str
    tokens_used: int = 0
    processing_time_ms: float = 0.0
    error: Optional[str] = None

@app.cls(
    image=vllm_image,
    gpu="A100",
    volumes={MODEL_DIR: model_volume},
    min_containers=1,
    timeout=300,
)
class AkawaIntelligence:
    
    @modal.enter()
    def setup(self):
        # MOCK PYAIRPORTS (Package deleted from PyPI but required by outlines)
        import sys
        from types import ModuleType
        dummy = ModuleType("pyairports")
        dummy.airports = ModuleType("pyairports.airports")
        dummy.airports.AIRPORT_LIST = []
        sys.modules["pyairports"] = dummy
        sys.modules["pyairports.airports"] = dummy.airports
        
        from vllm import LLM
        # Load 20B parameters model
        self.llm = LLM(MODEL_NAME, download_dir=MODEL_DIR, tensor_parallel_size=1)

    @modal.fastapi_endpoint(method="POST", docs=True)
    def generate_report(self, req: GenerateRequest) -> GenerateResponse:
        try:
            import time
            start = time.time()
            from vllm import SamplingParams
            sampling_params = SamplingParams(
                temperature=req.temperature,
                max_tokens=req.max_tokens,
            )
            text_to_generate = req.prompt if req.prompt else req.input_text
            
            # Application logging
            print(f"=== INCOMING GENERATE REQUEST ===")
            print(f"Input Data: {req.input_text}")
            print(f"Prompt: {req.prompt}")
            print(f"Text to Generate: {text_to_generate}")
            
            out = self.llm.generate([text_to_generate], sampling_params)
            generated_text = out[0].outputs[0].text
            ms = (time.time() - start) * 1000
            usage = len(out[0].outputs[0].token_ids)
            
            print(f"=== GENERATION OUTPUT ===")
            print(f"Reasoning/Generated text: {generated_text.strip()}")
            print(f"Tokens Used: {usage}")
            print(f"Processing Time (ms): {ms:.2f}")
            print(f"=================================\n")
            
            return GenerateResponse(
                report=generated_text.strip(),
                tokens_used=usage,
                processing_time_ms=ms
            )
        except Exception as e:
            import traceback
            traceback.print_exc()
            return GenerateResponse(report="", error=str(e))
