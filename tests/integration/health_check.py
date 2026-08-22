import requests
import sys

SERVICES = {
    "auth-service": "http://localhost:8081/health",
    "user-service": "http://localhost:8082/health",
    "room-service": "http://localhost:8083/health",
    "video-service": "http://localhost:8084/health",
    "ws-gateway": "http://localhost:8085/health",
    "sync-service": "http://localhost:8086/health", # Note: sync-service port was 8080 in docker-compose, but let's verify
    "parser-service": "http://localhost:8089/health",
    "kong": "http://localhost:8001/status"  # Kong admin API status endpoint
}

def check_health():
    print(f"{'Service':<20} | {'Status':<10} | {'Response'}")
    print("-" * 50)
    for name, url in SERVICES.items():
        try:
            response = requests.get(url, timeout=5)
            if response.status_code == 200:
                print(f"{name:<20} | OK        | {response.status_code}")
            else:
                print(f"{name:<20} | ERROR     | {response.status_code}")
        except Exception as e:
            print(f"{name:<20} | DOWN       | {str(e)[:30]}")

if __name__ == "__main__":
    check_health()
