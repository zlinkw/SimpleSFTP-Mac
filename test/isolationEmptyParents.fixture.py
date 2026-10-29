"""Small isolated filesystem fixture; no server, tmux or research data."""
import json, os, pathlib, sys, tempfile
namespace = {"__name__": "fixture", "__file__": str(pathlib.Path(sys.argv[1]).resolve())}
exec(compile(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"),sys.argv[1],"exec"),namespace)
root = pathlib.Path(tempfile.mkdtemp(prefix="isolation-empty-parents-"))
_, identity = namespace["root_guard"](str(root))
def run(**request):
    return namespace["main"]({"root":str(root),"rootIdentity":identity,**request})
def refuse(code, **request):
    try: run(**request)
    except namespace["GuardError"] as error: assert error.code==code,(code,error.code)
    else: raise AssertionError("expected "+code)
def prepare(name, digit):
    source=root/"work_dirs"/"nested"/name
    source.mkdir(parents=True)
    (source/"result.txt").write_text("fixture",encoding="utf-8")
    batch="job-"+digit*48
    target={"relativePath":"work_dirs/nested/"+name,"destination":"clean_dir/"+batch+"/work_dirs/nested/"+name,"archiveBatch":batch,"type":"directory"}
    future=run(action="inspect-isolation-parents",destinations=[target["destination"]],forReplacement=True)["targets"]
    inspected=namespace["isolate_inspect"](str(root),target)
    run(action="isolate",operationId="move-"+name,target={**target,**inspected,"destination":target["destination"]})
    entry=run(action="batch-inspect",authorizationMode="confirmed_paths",targets=[{"relativePath":target["destination"],"type":"directory"}])["targets"][0]
    run(action="delete-fast",authorizationMode="confirmed_paths",operationId="delete-"+name,entries=[entry])
    return target,future
target,future=prepare("one","a")
refuse("CONFIRM_REQUIRED",action="prune-isolation-parents",parentConfirmations=1,destinations=[target["destination"]],entries=future)
result=run(action="prune-isolation-parents",parentConfirmations=2,destinations=[target["destination"]],entries=future)
assert result["receipt"]["emptyDirectoriesRemoved"]==3,result
assert not (root/"clean_dir"/target["archiveBatch"]).exists()
assert (root/"clean_dir/.operations").is_dir()
# A later file or an unapproved empty child is never removed recursively.
target,future=prepare("two","b")
batch=root/"clean_dir"/target["archiveBatch"]
(batch/"keep.txt").write_text("keep",encoding="utf-8")
refuse("EMPTY_ISOLATION_PARENT_NOT_EMPTY",action="prune-isolation-parents",parentConfirmations=2,destinations=[target["destination"]],entries=future)
assert (batch/"keep.txt").read_text(encoding="utf-8")=="keep"
# Current legacy residual hierarchies can be frozen and explicitly confirmed.
target,_=prepare("three","c")
legacy=run(action="inspect-isolation-parents",destinations=[target["destination"]],forReplacement=False)
assert legacy["eligible"] and len(legacy["targets"])==3
assert run(action="prune-isolation-parents",parentConfirmations=2,destinations=[target["destination"]],entries=legacy["targets"])["state"]=="completed"
refuse("EMPTY_ISOLATION_SCOPE_INVALID",action="prune-isolation-parents",parentConfirmations=2,destinations=[target["destination"]],entries=[{"relativePath":"clean_dir","type":"directory"}])
target,future=prepare("four","d")
future[0]={**future[0],"future":False,"device":"wrong","inode":"wrong"}
refuse("ENTRY_IDENTITY_CHANGED",action="prune-isolation-parents",parentConfirmations=2,destinations=[target["destination"]],entries=future)
target,future=prepare("five","e")
original_parent_cd=namespace["parent_cd"]
def failed_parent_cd(*args): namespace["deny"]("PARENT_CD_FAILED")
namespace["parent_cd"]=failed_parent_cd
refuse("PARENT_CD_FAILED",action="prune-isolation-parents",parentConfirmations=2,destinations=[target["destination"]],entries=future)
namespace["parent_cd"]=original_parent_cd
assert all((root/row["relativePath"]).is_dir() for row in future)
target,future=prepare("six","f")
(root/"clean_dir"/target["archiveBatch"]/"unapproved-empty").mkdir()
refuse("EMPTY_ISOLATION_PARENT_NOT_EMPTY",action="prune-isolation-parents",parentConfirmations=2,destinations=[target["destination"]],entries=future)
assert (root/"clean_dir"/target["archiveBatch"]/"unapproved-empty").is_dir()
print(json.dumps({"ok":True,"onlyEmptyDirectories":True,"legacySupported":True}))
