import json
import os
import sys

from groq import Groq


SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["order"],
    "properties": {
        "order": {"type": "array", "items": {"type": "integer"}}
    },
}


def main():
    request = json.load(sys.stdin)
    if not os.getenv("GROQ_API_KEY"):
        raise RuntimeError("Falta configurar GROQ_API_KEY en el archivo .env.")

    model = os.getenv("GROQ_SETLIST_MODEL") or os.getenv("GROQ_MODEL") or "openai/gpt-oss-120b"
    count = int(request["count"])
    client = Groq(api_key=os.environ["GROQ_API_KEY"], timeout=90.0, max_retries=1)
    kwargs = dict(
        model=model,
        messages=[
            {
                "role": "system",
                "content": (
                    "Crea el mejor orden según desc. n=cantidad aproximada, dur=minutos, target_s=segundos "
                    "totales y d=segundos por canción. Usa solo índices recibidos, sin repetir. Respeta categorías, "
                    "energía y variedad; aproxima target_s sin excederlo. No inventes canciones. Devuelve solo índices en JSON."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {"n": count, "dur": request["duration"], "target_s": request["targetSeconds"], "desc": request["prompt"], "songs": request["songs"]},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
            },
        ],
        response_format={"type": "json_schema", "json_schema": {"name": "setlist_order", "strict": True, "schema": SCHEMA}},
        temperature=0,
        max_completion_tokens=min(700, max(120, count * 10)),
        top_p=1,
    )
    if model.startswith("openai/gpt-oss-"):
        kwargs["reasoning_effort"] = "low"
    completion = client.chat.completions.create(**kwargs)
    usage = completion.usage
    if usage:
        print(
            f"[Groq usage] model={completion.model} input={usage.prompt_tokens} "
            f"output={usage.completion_tokens} total={usage.total_tokens}",
            file=sys.stderr,
            flush=True,
        )
    message = completion.choices[0].message.content if completion.choices else ""
    result = json.loads(message or "{}")
    order = result.get("order")
    if not isinstance(order, list):
        raise ValueError("Groq no devolvió un orden de canciones válido.")
    return {"order": order}


if __name__ == "__main__":
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except Exception as exc:
        message = str(exc)
        status = 502
        if "401" in message or "authentication" in message.lower():
            message = "Groq rechazó la clave configurada. Revisa GROQ_API_KEY en .env."
        elif "429" in message:
            message = "Groq limitó temporalmente las solicitudes. Espera un momento e inténtalo otra vez."
            status = 429
        elif "404" in message:
            message = "El modelo configurado no está disponible. Revisa GROQ_SETLIST_MODEL en .env."
        print(json.dumps({"error": message, "status": status}, ensure_ascii=False))
        sys.exit(1)
