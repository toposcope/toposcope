import os
import traceback

from flask import Flask

from billing import charge

app = Flask(__name__)


@app.post("/pay")
def pay():
    return charge({})


@app.errorhandler(Exception)
def uncaught(error):
    # The uncaught-error path: the traceback as the runtime prints it.
    with open(os.environ["OUT"], "w") as out:
        out.write("".join(traceback.format_exception(error)))
    with open(os.environ["OUT"] + ".type", "w") as out:
        out.write(type(error).__name__)
    return "", 500


if __name__ == "__main__":
    app.test_client().post("/pay")
