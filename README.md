# PROGRAMA-ETIQUETAS

Impresora de etiquetas **HPRT HT300** (POS-D LP300X, 203 dpi) manejada desde un celular Android (Termux), con una página web para diseñar e imprimir desde cualquier dispositivo de la red.

```
celular / iPad / Mac / PC ──navegador──▶ Samsung :8091 (etiquetas.js) ──TCP 9100──▶ HT300
```

- **Página:** `http://etiche.local:8091` (o `http://IP_DEL_SAMSUNG:8091`).
- **Diseño en el navegador:** imagen con tramado, textos con `{campos}`, códigos de barras, QR y recuadros; alineación, imán y guías. Se dibuja a 8 puntos/mm y viaja como `BITMAP` de TSPL, así que la vista previa es lo que sale.
- **Rollos:** un perfil por tipo de papel (tamaño, sensor gap / marca negra / continuo, origen). Cambiar de rollo ajusta el sensor y calibra.
- **Actualización:** la carpeta `public/` se baja sola de este repo cada 5 minutos (o con "Buscar actualización" en la pestaña Rollos). Los cambios de `etiquetas.js` se instalan a mano.

## Instalar en Termux

```bash
bash instalar.sh
```

Queda en `~/programa-etiquetas` con su `config.json` (ver `config.example.json`) y sus datos en `data/` (perfiles y plantillas, fuera del repo).

## Protocolo de la impresora

Además de TSPL, la HT300 entiende comandos de configuración de HPRT por el mismo puerto (USB o TCP 9100):

| Comando | Respuesta |
|---|---|
| `ESC FS "& V1 getval \"clave\"\r\n"` | texto terminado en `0x00` |
| `ESC FS "& V1 setval \"clave\" \"valor\"\r\n"` | ninguna |
| `ESC FS "& V1 do \"accion\"\r\n"` | ninguna |

- Claves útiles: `media_sensor` (`gap`, `black mark`, `continuous`), `sensor_select` (`reflective`, `transmissive`; al cambiar `media_sensor` la impresora lo elige sola y hay que fijarlo después si el papel pide otro), `printer_status`, `density`, `speed`, `print_mode`, `eth_ip`, `eth_dhcp`, `version`.
- Acciones: `calibrate_sensor`, `configguration_page` (así, con doble g), `print_test_page`, `reset_printer`.
- `printer_status` → `"printer status:\0"` + 4 bytes: lista `00 00 02 00`, cabezal abierto `00 20 00 00`, calibrando `00 00 01 00`.
- **No consultar `country_code`**: el firmware vuelca unos 64 KB de memoria.
- Con `SIZE` menor a 108 mm la impresora centra la ventana en el cabezal; por eso se manda siempre `SIZE 108 mm` y el origen X va en `REFERENCE`. La Y va con `SHIFT` para no recortar el pie.
- Una sola conversación a la vez: dos programas consultando al mismo tiempo desordenan las respuestas (también USB + red); se arregla apagando la impresora.
- **No consultar nada mientras la impresora se mueve.** Con lectura reflectiva, un `getval` durante una impresión o una calibración la desorienta (imprime ~10 mm y LED rojo) hasta recalibrar. El servidor calla durante el tiempo estimado de impresión y 20 s tras `calibrate_sensor`.
- Los trabajos copian la cabecera de BarTender (`SIZE`, `DIRECTION 0,0`, `REFERENCE`, `OFFSET 0 mm`, `SET PEEL OFF`, `SET CUTTER OFF`, `SET TEAR ON`). **No mandar `SET RIBBON` en cada trabajo**: con el sensor en lectura reflectiva dejaba la impresora sin poder avanzar (LED rojo). La cinta se fija con `setval "sw_ribbon"` al cambiar de rollo.
