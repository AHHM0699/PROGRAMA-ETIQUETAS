#!/data/data/com.termux/files/usr/bin/bash
# Instala o actualiza PROGRAMA-ETIQUETAS en Termux (Samsung).
# Uso (dentro de Termux):  bash /ruta/a/PROGRAMA-ETIQUETAS/instalar.sh
#
# Queda en ~/programa-etiquetas con su propio config.json y data/.
# Si encuentra la instalación vieja dentro de ~/servidor-caja, se muda:
# copia perfiles y plantillas, toma la configuración de la impresora y
# saca el lanzador viejo del arranque. No toca la caja, la cámara ni las alertas.
set -e

ORIGEN="$(cd "$(dirname "$0")" && pwd)"
DESTINO="$HOME/programa-etiquetas"
VIEJO="$HOME/servidor-caja"

command -v node >/dev/null || pkg install -y nodejs-lts

mkdir -p "$DESTINO/data"
rm -rf "$DESTINO/public"
cp -r "$ORIGEN/etiquetas.js" "$ORIGEN/public" "$ORIGEN/config.example.json" "$DESTINO/"

# Mudanza de datos (solo si todavía no hay datos propios).
if [ -d "$VIEJO/data/etiquetas" ] && [ ! -f "$DESTINO/data/perfiles.json" ]; then
  cp -r "$VIEJO/data/etiquetas/." "$DESTINO/data/"
  echo "Datos copiados desde $VIEJO/data/etiquetas (el original queda como respaldo)"
fi

# config.json: si no existe, se arma con el bloque "etiquetas" del config de la caja.
cd "$DESTINO"
if [ ! -f config.json ]; then
  node -e "
  const fs=require('fs');
  let base={};try{base=JSON.parse(fs.readFileSync('config.example.json','utf8'))}catch(e){}
  let viejo={};try{viejo=(JSON.parse(fs.readFileSync(process.argv[1],'utf8').replace(/^﻿/,'')).etiquetas)||{}}catch(e){}
  const c=Object.assign(base,viejo);
  if(c.actualizar) c.actualizar.repo='AHHM0699/PROGRAMA-ETIQUETAS';
  fs.writeFileSync('config.json',JSON.stringify(c,null,2));
  console.log('config.json:',JSON.stringify(c));" "$VIEJO/config.json"
fi

# Lanzador: relanza el servidor si se cae.
cat > "$DESTINO/arrancar.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock 2>/dev/null
cd "$HOME/programa-etiquetas"
while true; do
  node etiquetas.js >> "$HOME/programa-etiquetas/etiquetas.log" 2>&1
  sleep 10
done
EOF
chmod +x "$DESTINO/arrancar.sh"

# Fuera la instalación vieja: su lanzador y su entrada en .bashrc.
pkill -f servidor-caja/arrancar-etiquetas.sh 2>/dev/null || true
pkill -f "node etiquetas.js" 2>/dev/null || true
if [ -f "$HOME/.bashrc" ]; then
  sed -i '/# servidor-caja: etiquetas/d; /servidor-caja\/arrancar-etiquetas.sh/d' "$HOME/.bashrc"
fi
rm -f "$VIEJO/arrancar-etiquetas.sh"

# Arranque automático al abrir Termux.
MARCA="# programa-etiquetas: arranque automatico"
if ! grep -q "$MARCA" "$HOME/.bashrc" 2>/dev/null; then
  cat >> "$HOME/.bashrc" <<EOF
$MARCA
pgrep -f programa-etiquetas/arrancar.sh >/dev/null || nohup "\$HOME/programa-etiquetas/arrancar.sh" >/dev/null 2>&1 &
EOF
fi

# Arranque al encender el celular, sin abrir Termux (~/.termux/boot).
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/programa-etiquetas.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
pgrep -f programa-etiquetas/arrancar.sh >/dev/null || nohup "$HOME/programa-etiquetas/arrancar.sh" >/dev/null 2>&1 &
EOF
chmod +x "$HOME/.termux/boot/programa-etiquetas.sh"

sleep 2
pgrep -f programa-etiquetas/arrancar.sh >/dev/null || nohup "$DESTINO/arrancar.sh" >/dev/null 2>&1 &

echo
echo "Instalado en $DESTINO"
echo "Página:    http://etiche.local:8091   (o http://IP_DEL_SAMSUNG:8091)"
echo "Registro:  tail -f ~/programa-etiquetas/etiquetas.log"
