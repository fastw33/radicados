"""Conversión local por UNO: un motor preparado, documentos cerrados entre trabajos."""
import json
import pathlib
import subprocess
import sys
import time

import uno
import unohelper
from com.sun.star.task import XInteractionHandler


class RejectInteraction(unohelper.Base, XInteractionHandler):
    def handle(self, request):
        for continuation in request.getContinuations():
            abort = continuation.queryInterface(uno.getTypeByName('com.sun.star.task.XInteractionAbort'))
            if abort:
                abort.select()
                return


def prop(name, value):
    item = uno.createUnoStruct('com.sun.star.beans.PropertyValue')
    item.Name, item.Value = name, value
    return item


def reply(value):
    print(json.dumps(value), flush=True)


def main():
    binary, profile, pipe, timeout = sys.argv[1:]
    options = {'creationflags': subprocess.CREATE_NO_WINDOW} if sys.platform == 'win32' else {}
    office = subprocess.Popen([
        binary, '-env:UserInstallation=' + pathlib.Path(profile).as_uri(),
        '--headless', '--nologo', '--nodefault', '--nofirststartwizard', '--norestore',
        '--accept=pipe,name=' + pipe + ';urp;StarOffice.ServiceManager',
    ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **options)
    desktop = None
    anchor = None
    try:
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
        deadline = time.monotonic() + float(timeout)
        while True:
            try:
                context = resolver.resolve('uno:pipe,name=' + pipe + ';urp;StarOffice.ComponentContext')
                break
            except Exception:
                if time.monotonic() >= deadline or office.poll() is not None:
                    raise RuntimeError('El motor no pudo iniciarse')
                time.sleep(0.1)
        desktop = context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', context)
        # Mantiene Writer activo al cerrar el último documento de una solicitud.
        anchor = desktop.loadComponentFromURL('private:factory/swriter', '_blank', 0, (prop('Hidden', True),))
        reply({'ready': True})
        for line in sys.stdin:
            request = json.loads(line)
            if request.get('stop'):
                break
            document = None
            success = False
            restart = False
            try:
                document = desktop.loadComponentFromURL(pathlib.Path(request['input']).as_uri(), '_blank', 0, (
                    prop('Hidden', True), prop('ReadOnly', True), prop('Silent', True),
                    prop('UpdateDocMode', uno.getConstantByName('com.sun.star.document.UpdateDocMode.NO_UPDATE')),
                    prop('MacroExecutionMode', uno.getConstantByName('com.sun.star.document.MacroExecMode.NEVER_EXECUTE')),
                    prop('InteractionHandler', RejectInteraction()),
                ))
                if document is None:
                    raise RuntimeError('Documento no compatible')
                document.storeToURL(pathlib.Path(request['output']).as_uri(), (
                    prop('FilterName', 'writer_pdf_Export'), prop('Overwrite', True),
                ))
                success = True
            except Exception:
                success = False
            finally:
                if document is not None:
                    try:
                        document.close(True)
                    except Exception:
                        try:
                            document.dispose()
                        except Exception:
                            restart = True
            reply({'id': request['id'], 'ok': success, 'restart': restart})
            if restart:
                break
    finally:
        if anchor:
            try:
                anchor.close(True)
            except Exception:
                pass
        if desktop:
            try:
                desktop.terminate()
            except Exception:
                pass
        try:
            office.wait(timeout=3)
        except subprocess.TimeoutExpired:
            if sys.platform == 'win32':
                subprocess.run(['taskkill', '/PID', str(office.pid), '/T', '/F'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **options)
            else:
                office.terminate()


if __name__ == '__main__':
    main()
