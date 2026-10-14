"""Minimal example of calling ChatGPT from a Python harness."""
from client import BridgeClient


def main() -> None:
    prompt = "Réponds uniquement par OK."
    response = BridgeClient().ask(prompt, timeout=180)
    print("Réponse reçue :")
    print(response)


if __name__ == "__main__":
    main()
