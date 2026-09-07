"""
Simplificador de SVG - reduce la cantidad de nodos en los paths de un SVG
usando el algoritmo Douglas-Peucker, para que sea mas liviano de importar
en FreeCAD (evita el error de "out of memory" al hacer Draft to Sketch).

USO:
    python simplificar_svg.py entrada.svg salida.svg [--tolerancia 1.0] [--puntos-por-curva 20]

    --tolerancia: que tan agresiva es la simplificacion. Valores mas altos
                  = menos nodos pero forma menos fiel al original.
                  Prueba con 0.5, 1.0, 2.0, 5.0 segun tu caso.

    --puntos-por-curva: cuantos puntos se muestrean de cada curva Bezier
                        original antes de simplificar. Mas puntos = mas
                        fiel pero mas lento.

Requiere: pip install svgpathtools --break-system-packages
"""

import argparse
import xml.etree.ElementTree as ET
from svgpathtools import svg2paths2, wsvg


def douglas_peucker(points, tolerancia):
    """Reduce una lista de puntos complejos (x + yj) usando Douglas-Peucker."""
    if len(points) < 3:
        return points

    def perpendicular_distance(pt, line_start, line_end):
        if line_start == line_end:
            return abs(pt - line_start)
        num = abs(
            (line_end.real - line_start.real) * (line_start.imag - pt.imag)
            - (line_start.real - pt.real) * (line_end.imag - line_start.imag)
        )
        den = abs(line_end - line_start)
        return num / den if den != 0 else 0

    dmax = 0.0
    index = 0
    end = len(points) - 1
    for i in range(1, end):
        d = perpendicular_distance(points[i], points[0], points[end])
        if d > dmax:
            index = i
            dmax = d

    if dmax > tolerancia:
        left = douglas_peucker(points[: index + 1], tolerancia)
        right = douglas_peucker(points[index:], tolerancia)
        return left[:-1] + right
    else:
        return [points[0], points[end]]


def simplificar_path(path, tolerancia, puntos_por_curva):
    """Convierte un Path de svgpathtools en una polilinea simplificada
    y devuelve un nuevo Path hecho de segmentos de linea (Line)."""
    from svgpathtools import Path, Line

    puntos = []
    for seg in path:
        n = puntos_por_curva
        for i in range(n):
            t = i / n
            puntos.append(seg.point(t))
    if len(path) > 0:
        puntos.append(path[-1].point(1.0))

    puntos_simplificados = douglas_peucker(puntos, tolerancia)

    nuevo_path = Path()
    for i in range(len(puntos_simplificados) - 1):
        nuevo_path.append(Line(puntos_simplificados[i], puntos_simplificados[i + 1]))

    # Verificamos si el path original era cerrado comparando directamente
    # el primer y ultimo punto, en vez de usar path.isclosed() (que puede
    # lanzar AssertionError en paths con pequenas discontinuidades).
    try:
        inicio_original = path[0].start
        fin_original = path[-1].end
        era_cerrado = abs(inicio_original - fin_original) < 1e-6
    except (IndexError, AttributeError):
        era_cerrado = False

    if era_cerrado and len(nuevo_path) > 0:
        if nuevo_path[-1].end != nuevo_path[0].start:
            nuevo_path.append(Line(nuevo_path[-1].end, nuevo_path[0].start))

    return nuevo_path


def contar_nodos(paths):
    return sum(len(p) + 1 for p in paths)


def main():
    parser = argparse.ArgumentParser(description="Simplifica los paths de un SVG")
    parser.add_argument("entrada", help="Archivo SVG de entrada")
    parser.add_argument("salida", help="Archivo SVG de salida")
    parser.add_argument("--tolerancia", type=float, default=1.0,
                         help="Agresividad de la simplificacion (default 1.0)")
    parser.add_argument("--puntos-por-curva", type=int, default=20,
                         help="Puntos muestreados por curva antes de simplificar (default 20)")
    args = parser.parse_args()

    print(f"Leyendo {args.entrada} ...")
    paths, attributes, svg_attributes = svg2paths2(args.entrada)

    nodos_antes = contar_nodos(paths)
    print(f"Nodos antes de simplificar: {nodos_antes}")

    nuevos_paths = []
    fallidos = 0
    for p in paths:
        if len(p) == 0:
            nuevos_paths.append(p)
            continue
        try:
            nuevo = simplificar_path(p, args.tolerancia, args.puntos_por_curva)
            nuevos_paths.append(nuevo)
        except Exception as e:
            # Si un path individual falla, lo dejamos sin simplificar
            # en vez de detener todo el script.
            fallidos += 1
            nuevos_paths.append(p)

    if fallidos:
        print(f"Aviso: {fallidos} paths no se pudieron simplificar y se dejaron igual.")

    nodos_despues = contar_nodos(nuevos_paths)
    print(f"Nodos despues de simplificar: {nodos_despues}")
    if nodos_antes > 0:
        reduccion = 100 * (1 - nodos_despues / nodos_antes)
        print(f"Reduccion: {reduccion:.1f}%")

    # Limpia atributos de estilo que puedan interferir (deja solo stroke/fill basicos)
    nuevos_attrs = []
    for a in attributes:
        nuevo_a = dict(a)
        nuevo_a.pop("d", None)
        nuevos_attrs.append(nuevo_a)

    wsvg(nuevos_paths, attributes=nuevos_attrs, svg_attributes=svg_attributes,
         filename=args.salida)
    print(f"Guardado en {args.salida}")


if __name__ == "__main__":
    main()