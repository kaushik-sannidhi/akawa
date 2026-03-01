import requests
import time

# The endpoint created by modal
API_URL = "https://apat7--akawa-llm-intelligence-akawaintelligence-generate-report.modal.run"

def test_generate_report():
    print(f"Testing endpoint: {API_URL}")
    prompt = "What are the first 5 elements of the periodic table? Please list them concisely."
    payload = {
        "input_text": prompt,
        "max_tokens": 100,
        "temperature": 0.5
    }
    
    print(f"Sending prompt: '{prompt}'")
    start = time.time()
    try:
        response = requests.post(API_URL, json=payload)
        response.raise_for_status()
        data = response.json()
        print(f"Response Time: {time.time() - start:.2f}s")
        print(f"Response Data: {data}")
        print("Response Text:")
        print(data.get("report", "No report text in response"))
        
        if data.get("error"):
            print(f"Error returned by API: {data['error']}")
            
    except requests.exceptions.RequestException as e:
        print(f"Request failed: {e}")
        if hasattr(e, 'response') and e.response is not None:
            print(f"Response Body: {e.response.text}")

if __name__ == "__main__":
    test_generate_report()
