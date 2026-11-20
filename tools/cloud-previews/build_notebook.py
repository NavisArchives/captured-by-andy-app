#!/usr/bin/env python3
"""Builds the Colab notebook from make_previews.py.

  python3 build_notebook.py                      -> Captured_by_Andy_previews.ipynb (kept in git)
  python3 build_notebook.py <manifest.json> <out> -> a copy that carries the clip list
                                                    itself, for when the Google Drive app
                                                    on the Mac can't upload it (not in git:
                                                    it lists file paths).
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def cell(kind, text):
    c = {"cell_type": kind, "metadata": {}, "source": text.splitlines(keepends=True)}
    if kind == "code":
        c.update(execution_count=None, outputs=[])
    return c


def build(manifest=None):
    script = open(os.path.join(HERE, "make_previews.py")).read()
    cells = [
        cell("markdown", "# Captured by Andy: previews made in Google's cloud\n\n"
             "Makes the light 720p previews of your clips here, next to Google Drive, so your Mac only downloads a few MB per clip.\n\n"
             "**Run:** menu *Runtime → Run all*. Allow Google Drive when asked. Keep this tab open until it says *Finished*. "
             "It can be stopped and run again: finished clips are skipped.\n\n"
             "Originals are only read. Previews go to *My Drive/STORAGE/CBA-PREVIEWS-720*. Captured by Andy picks them up by itself."),
        cell("code", "from google.colab import drive\ndrive.mount('/content/drive')"),
    ]
    if manifest:
        cells.append(cell("code", "%%writefile /content/manifest.json\n" + open(manifest).read()))
    cells += [
        cell("code", "%%writefile /content/make_previews.py\n" + script),
        cell("code", "!python3 /content/make_previews.py"),
    ]
    return {"cells": cells, "metadata": {"colab": {"provenance": []}, "kernelspec": {"display_name": "Python 3", "name": "python3"},
            "language_info": {"name": "python"}}, "nbformat": 4, "nbformat_minor": 0}


if __name__ == "__main__":
    if len(sys.argv) == 3:
        out, nb = sys.argv[2], build(sys.argv[1])
    else:
        out, nb = os.path.join(HERE, "Captured_by_Andy_previews.ipynb"), build()
    with open(out, "w") as f:
        json.dump(nb, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(out)
