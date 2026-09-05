"""Per-user home page layout: custom categories + tool→category assignments."""
import json

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.core.auth import require_user
from app.core.db import User
from app.core.settings import _get_user_setting, _set_user_setting

router = APIRouter()

_SETTING_KEY = "home_layout"


class Category(BaseModel):
    id: str
    label: str


class HomeLayout(BaseModel):
    categories: list[Category] = []
    assignments: dict[str, str] = {}


@router.get("/api/home-layout")
def get_home_layout(user: User = Depends(require_user)) -> HomeLayout:
    """Return the user's saved home layout, or an empty layout (use built-in defaults)."""
    raw = _get_user_setting(user.id, _SETTING_KEY)
    if not raw:
        return HomeLayout()
    try:
        data = json.loads(raw)
        return HomeLayout(**data)
    except (TypeError, ValueError):
        return HomeLayout()


@router.post("/api/home-layout")
def save_home_layout(layout: HomeLayout, user: User = Depends(require_user)) -> HomeLayout:
    """Persist the user's home layout as JSON."""
    _set_user_setting(user.id, _SETTING_KEY, layout.model_dump_json())
    return layout
